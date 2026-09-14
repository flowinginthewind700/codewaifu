// Live2D 数字人的渲染宿主:把 vendored Cubism Framework 接到一张 canvas 上。
//
// 这一层是「独立模块」的核心:对外只暴露 `Live2DHost.create()` / `setAudioLevel()` /
// `release()`,不依赖 React、不依赖 TTS 引擎实现(口型电平由调用方每帧喂进来)。
//
// 参考实现:thirdparty/mazu-live-agent/web/lib/live2d/src/{lappmodel,lappview,
// lappsubdelegate,lapplive2dmanager}.ts。update/draw 的顺序与它逐步对齐 —— Cubism 的
// 参数是「motion → 表情 → 拖拽 → 呼吸 → 物理 → 口型 → pose」层层叠加的,顺序错了
// 会出现口型被 pose 覆盖、或眨眼把表情吃掉这类很难查的现象。
//
// ⛔ CubismFramework 是**页面级单例**,只能 startUp/initialize 一次且永不 dispose:
//    数字人面板会随路由反复挂载/卸载,dispose 会连带释放 shader 单例与 ID 管理器,
//    下一次挂载必崩。释放只释放 model/renderer/texture/GL。
import { CubismDefaultParameterId } from "./vendor/framework/cubismdefaultparameterid";
import { CubismModelSettingJson } from "./vendor/framework/cubismmodelsettingjson";
import { BreathParameterData, CubismBreath } from "./vendor/framework/effect/cubismbreath";
import { CubismEyeBlink } from "./vendor/framework/effect/cubismeyeblink";
import type { ICubismModelSetting } from "./vendor/framework/icubismmodelsetting";
import type { CubismIdHandle } from "./vendor/framework/id/cubismid";
import { CubismFramework, LogLevel, Option } from "./vendor/framework/live2dcubismframework";
import { CubismMatrix44 } from "./vendor/framework/math/cubismmatrix44";
import { CubismViewMatrix } from "./vendor/framework/math/cubismviewmatrix";
import { CubismUserModel } from "./vendor/framework/model/cubismusermodel";
import type { ACubismMotion } from "./vendor/framework/motion/acubismmotion";
import type { CubismMotion } from "./vendor/framework/motion/cubismmotion";
import {
  InvalidMotionQueueEntryHandleValue,
  type CubismMotionQueueEntryHandle,
} from "./vendor/framework/motion/cubismmotionqueuemanager";
import { csmMap } from "./vendor/framework/type/csmmap";
import { csmVector } from "./vendor/framework/type/csmvector";
import { loadCubismCore, live2dAsset } from "./assets";
import { stripLipSyncFromExpressionBytes } from "@shared/expression";
import { lipEnvelope } from "./lip";
import type { Live2DCharacter } from "./catalog";

export type GLContext = WebGLRenderingContext | WebGL2RenderingContext;

/** 动作组与优先级(与 Cubism 样例同口径)。 */
export const MOTION_GROUP_IDLE = "Idle";
export const MOTION_GROUP_TAP_BODY = "TapBody";
export const PRIORITY_IDLE = 1;
export const PRIORITY_NORMAL = 2;
export const PRIORITY_FORCE = 3;

const HIT_HEAD = "Head";
const HIT_BODY = "Body";

/** 单帧步长上限:切回前台时 dt 可能是几十秒,不夹会让物理与动作直接跳飞。 */
const MAX_DELTA = 0.05;

let frameworkStarted = false;
let frameworkPromise: Promise<void> | null = null;

/**
 * 确保 Cubism Core 已注入且 Framework 已 startUp + initialize。
 *
 * 幂等:并发调用共享一个 promise。日志级别压到 Warning —— 样例默认 Verbose,
 * 每帧都会往 console 打点,朗读页不该被数字人刷屏。
 */
export function ensureCubismFramework(): Promise<void> {
  if (frameworkStarted) return Promise.resolve();
  if (frameworkPromise) return frameworkPromise;
  frameworkPromise = (async () => {
    await loadCubismCore();
    if (!CubismFramework.isStarted()) {
      const option = new Option();
      option.logFunction = (message: string): void => console.warn(message);
      option.loggingLevel = LogLevel.LogLevel_Warning;
      CubismFramework.startUp(option);
    }
    if (!CubismFramework.isInitialized()) CubismFramework.initialize();
    frameworkStarted = true;
  })();
  frameworkPromise.catch(() => {
    frameworkPromise = null;
  });
  return frameworkPromise;
}

/** model3.json 里的相对路径 → 站内绝对 URL。 */
function resolveUrl(character: Live2DCharacter, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const base = character.model3Url.slice(0, character.model3Url.lastIndexOf("/") + 1);
  return `${base}${relative}`;
}

async function jsonBytes(url: string): Promise<ArrayBuffer> {
  return live2dAsset(url);
}

/** 把缓存里的图片字节上传成 GL 纹理(预乘 alpha,与 renderer 设置必须一致)。 */
async function uploadTexture(gl: GLContext, bytes: ArrayBuffer): Promise<WebGLTexture> {
  let source: ImageBitmap | HTMLImageElement;
  let objectUrl: string | null = null;
  if (typeof createImageBitmap === "function") {
    // 缓存给的是字节,不是 URL:走 blob → ImageBitmap,避免再发一次网络请求
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
    source = await createImageBitmap(await (await fetch(objectUrl)).blob());
  } else {
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
    source = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = (): void => resolve(img);
      img.onerror = (): void => reject(new Error("Live2D texture decode failed"));
      img.src = objectUrl as string;
    });
  }
  const texture = gl.createTexture();
  if (!texture) throw new Error("WebGL createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if ("close" in source) (source as ImageBitmap).close();
  return texture;
}

/**
 * 一个角色实例:装配 moc/表情/物理/pose/动作,并负责每帧的参数叠加与绘制。
 */
export class AvatarModel extends CubismUserModel {
  private _setting: ICubismModelSetting | null = null;
  private _homeDir = "";
  private _motions = new csmMap<string, CubismMotion>();
  private _expressions = new csmMap<string, ACubismMotion>();
  private _eyeBlinkIds = new csmVector<CubismIdHandle>();
  private _lipSyncIds = new csmVector<CubismIdHandle>();
  private _textures: WebGLTexture[] = [];
  private _ready = false;

  private _idAngleX: CubismIdHandle = null as unknown as CubismIdHandle;
  private _idAngleY: CubismIdHandle = null as unknown as CubismIdHandle;
  private _idAngleZ: CubismIdHandle = null as unknown as CubismIdHandle;
  private _idBodyAngleX: CubismIdHandle = null as unknown as CubismIdHandle;
  private _idEyeBallX: CubismIdHandle = null as unknown as CubismIdHandle;
  private _idEyeBallY: CubismIdHandle = null as unknown as CubismIdHandle;

  /** 当前口型开度 0..1(由 host 每帧写入口型参数)。 */
  public lipValue = 0;

  get isReady(): boolean {
    return this._ready;
  }

  /** 下载并装配一个角色的全部资产。失败直接抛错,由上层显示重试。 */
  public async setup(character: Live2DCharacter, gl: GLContext): Promise<void> {
    await ensureCubismFramework();
    const idManager = CubismFramework.getIdManager();
    this._idAngleX = idManager.getId(CubismDefaultParameterId.ParamAngleX);
    this._idAngleY = idManager.getId(CubismDefaultParameterId.ParamAngleY);
    this._idAngleZ = idManager.getId(CubismDefaultParameterId.ParamAngleZ);
    this._idBodyAngleX = idManager.getId(CubismDefaultParameterId.ParamBodyAngleX);
    this._idEyeBallX = idManager.getId(CubismDefaultParameterId.ParamEyeBallX);
    this._idEyeBallY = idManager.getId(CubismDefaultParameterId.ParamEyeBallY);

    this._homeDir = character.model3Url.slice(0, character.model3Url.lastIndexOf("/") + 1);
    const settingBytes = await jsonBytes(character.model3Url);
    const setting = new CubismModelSettingJson(settingBytes, settingBytes.byteLength);
    this._setting = setting;

    // --- moc / model ---
    const mocName: string = setting.getModelFileName();
    if (!mocName) throw new Error(`model3.json has no Moc reference (${character.id})`);
    const mocBytes = await live2dAsset(resolveUrl(character, mocName));
    // moc 一致性校验:Core 自带,损坏/版本不符时早失败,好过渲染出乱码模型
    this.loadModel(mocBytes, true);
    if (!this.getModel()) throw new Error(`Failed to create Live2D model (${character.id})`);

    // --- 眨眼 / 口型参数 id(动作与表情里内嵌的同名曲线都要被这两组接管) ---
    //   ⛔ 必须排在表情加载**之前**:剥表情里的口型条目要用到这份 id 列表。
    for (let i = 0; i < setting.getEyeBlinkParameterCount(); i += 1) {
      this._eyeBlinkIds.pushBack(setting.getEyeBlinkParameterId(i));
    }
    for (let i = 0; i < setting.getLipSyncParameterCount(); i += 1) {
      this._lipSyncIds.pushBack(setting.getLipSyncParameterId(i));
    }
    if (this._lipSyncIds.getSize() === 0) {
      // model3.json 没声明 LipSync 组时兜底到标准口型参数,否则数字人永远不张嘴
      this._lipSyncIds.pushBack(idManager.getId(CubismDefaultParameterId.ParamMouthOpenY));
    }

    // --- 表情 ---
    //   ⛔ 加载前把口型参数从 exp3.json 里摘掉(算法在 expression.ts,有单测)。
    //   表情类没有 motion 那套 setEffectIds API,不摘的话「说话时挂上的 happy
    //   表情」会每帧给 ParamMouthOpenY 加满 1,口型电平再叠加也被参数上限夹死
    //   —— 表现就是朗读时嘴一直全开、开度不随声音变。
    const lipSyncIds: string[] = [];
    for (let i = 0; i < this._lipSyncIds.getSize(); i += 1) {
      lipSyncIds.push(this._lipSyncIds.at(i).getString().s);
    }
    const expressionCount = setting.getExpressionCount();
    for (let i = 0; i < expressionCount; i += 1) {
      const file = setting.getExpressionFileName(i);
      if (!file) continue;
      const bytes = await live2dAsset(resolveUrl(character, file));
      const filtered = stripLipSyncFromExpressionBytes(bytes, lipSyncIds);
      const expression = this.loadExpression(
        filtered,
        filtered.byteLength,
        setting.getExpressionName(i),
      );
      if (expression) this._expressions.setValue(setting.getExpressionName(i), expression);
    }

    // --- 物理 / pose / userdata(缺文件就跳过,不报错) ---
    const physicsName = setting.getPhysicsFileName();
    if (physicsName) {
      const bytes = await live2dAsset(resolveUrl(character, physicsName));
      this.loadPhysics(bytes, bytes.byteLength);
    }
    const poseName = setting.getPoseFileName();
    if (poseName) {
      const bytes = await live2dAsset(resolveUrl(character, poseName));
      this.loadPose(bytes, bytes.byteLength);
    }
    const userDataName = setting.getUserDataFile();
    if (userDataName) {
      try {
        const bytes = await live2dAsset(resolveUrl(character, userDataName));
        this.loadUserData(bytes, bytes.byteLength);
      } catch {
        // userdata 只影响标注,加载失败不影响显示
      }
    }

    // --- 自动眨眼 + 呼吸 ---
    this._eyeBlink = CubismEyeBlink.create(setting);
    this._breath = CubismBreath.create();
    const breathParams = new csmVector<BreathParameterData>();
    breathParams.pushBack(new BreathParameterData(this._idAngleX, 0.0, 15.0, 6.5345, 0.5));
    breathParams.pushBack(new BreathParameterData(this._idAngleY, 0.0, 8.0, 3.5345, 0.5));
    breathParams.pushBack(new BreathParameterData(this._idAngleZ, 0.0, 10.0, 5.5345, 0.5));
    breathParams.pushBack(new BreathParameterData(this._idBodyAngleX, 0.0, 4.0, 15.5345, 0.5));
    breathParams.pushBack(
      new BreathParameterData(
        idManager.getId(CubismDefaultParameterId.ParamBreath),
        0.5,
        0.5,
        3.2345,
        1.0,
      ),
    );
    this._breath.setParameters(breathParams);

    // --- 布局(本站两个模型都没有 Layout,map 为空即恒等) ---
    const layout = new csmMap<string, number>();
    setting.getLayoutMap(layout);
    this.getModelMatrix().setupFromLayout(layout);

    // --- 动作全量预载:播放时才 fetch 会让第一次点击有明显延迟 ---
    await this.preloadMotions(setting);
    this.getModel().saveParameters();
    this._motionManager.stopAllMotions();
    this.setInitialized(true);

    // --- renderer / textures ---
    this.createRenderer(1);
    const renderer = this.getRenderer();
    renderer.startUp(gl);
    // 纹理走预乘 alpha,renderer 必须同口径,否则 shader 报错 + 边缘发黑
    renderer.setIsPremultipliedAlpha(true);
    const textureCount = setting.getTextureCount();
    for (let i = 0; i < textureCount; i += 1) {
      const name = setting.getTextureFileName(i);
      if (!name) continue;
      const bytes = await live2dAsset(resolveUrl(character, name));
      const texture = await uploadTexture(gl, bytes);
      this._textures.push(texture);
      renderer.bindTexture(i, texture);
    }
    this._ready = true;
  }

  private async preloadMotions(setting: ICubismModelSetting): Promise<void> {
    const groups: string[] = [];
    for (let i = 0; i < setting.getMotionGroupCount(); i += 1) groups.push(setting.getMotionGroupName(i));
    for (const group of groups) {
      const count = setting.getMotionCount(group);
      for (let i = 0; i < count; i += 1) {
        const file = setting.getMotionFileName(group, i);
        if (!file) continue;
        try {
          const bytes = await live2dAsset(resolveUrl({ model3Url: this._homeDir + "x.json" } as Live2DCharacter, file));
          const name = `${group}_${i}`;
          const motion = this.loadMotion(bytes, bytes.byteLength, name, undefined, undefined, setting, group, i);
          if (!motion) continue;
          // 声明这两个参数由「宿主效果」接管:motion3.json 里内嵌的 EyeBlink/
          //   LipSync 曲线从此被跳过,交给我们每帧喂的电平(updateFrame 里的口型段)。
          //   ⛔ 漏掉这一步,动作自带的一条静态嘴型曲线会盖住电平 —— 朗读时嘴不动。
          motion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);
          const existing = this._motions.getValue(name);
          if (existing) existing.release();
          this._motions.setValue(name, motion);
        } catch {
          // 单个动作坏了不该让整个角色上不来:跳过即可
        }
      }
    }
  }

  /** 播放指定动作;预载过的直接取,没取到的返回 invalid(不做运行时下载)。 */
  public startMotion(
    group: string,
    no: number,
    priority: number,
  ): CubismMotionQueueEntryHandle {
    if (priority === PRIORITY_FORCE) {
      this._motionManager.setReservePriority(priority);
    } else if (!this._motionManager.reserveMotion(priority)) {
      return InvalidMotionQueueEntryHandleValue;
    }
    const motion = this._motions.getValue(`${group}_${no}`) as CubismMotion;
    if (!motion) return InvalidMotionQueueEntryHandleValue;
    return this._motionManager.startMotionPriority(motion, false, priority);
  }

  public startRandomMotion(group: string, priority: number): CubismMotionQueueEntryHandle {
    const setting = this._setting;
    if (!setting) return InvalidMotionQueueEntryHandleValue;
    const count = setting.getMotionCount(group);
    if (count <= 0) return InvalidMotionQueueEntryHandleValue;
    return this.startMotion(group, Math.floor(Math.random() * count), priority);
  }

  public setExpression(name: string): void {
    const motion = this._expressions.getValue(name);
    if (motion) this._expressionManager.startMotion(motion, false);
  }

  public setRandomExpression(): void {
    const size = this._expressions.getSize();
    if (size === 0) return;
    const index = Math.floor(Math.random() * size);
    this.setExpression(this._expressions._keyValues[index].first);
  }

  /** 命中区域测试(点击头部换表情、点击身体播动作)。 */
  public hitTest(areaName: string, x: number, y: number): boolean {
    const setting = this._setting;
    if (!setting || this.getOpacity() < 1) return false;
    for (let i = 0; i < setting.getHitAreasCount(); i += 1) {
      if (setting.getHitAreaName(i) === areaName) return this.isHit(setting.getHitAreaId(i), x, y);
    }
    return false;
  }

  /**
   * 推进一帧参数。
   *
   * @param dt 秒(已夹到 MAX_DELTA)
   * @param lipValue 本帧口型开度 0..1
   */
  public updateFrame(dt: number, lipValue: number): void {
    if (!this._ready) return;
    this.lipValue = lipValue;

    this._dragManager.update(dt);
    const dragX: number = this._dragManager.getX();
    const dragY: number = this._dragManager.getY();
    this._dragX = dragX;
    this._dragY = dragY;

    const model = this.getModel();
    let motionUpdated = false;
    model.loadParameters();
    if (this._motionManager.isFinished()) {
      this.startRandomMotion(MOTION_GROUP_IDLE, PRIORITY_IDLE);
    } else {
      motionUpdated = this._motionManager.updateMotion(model, dt);
    }
    model.saveParameters();

    if (!motionUpdated && this._eyeBlink) this._eyeBlink.updateParameters(model, dt);
    if (this._expressionManager) this._expressionManager.updateMotion(model, dt);

    // 拖拽:头/身/眼跟随指针
    model.addParameterValueById(this._idAngleX, dragX * 30);
    model.addParameterValueById(this._idAngleY, dragY * 30);
    model.addParameterValueById(this._idAngleZ, dragX * dragY * -30);
    model.addParameterValueById(this._idBodyAngleX, dragX * 10);
    model.addParameterValueById(this._idEyeBallX, dragX);
    model.addParameterValueById(this._idEyeBallY, dragY);

    if (this._breath) this._breath.updateParameters(model, dt);
    if (this._physics) this._physics.evaluate(model, dt);

    // 口型:weight 0.8 与样例一致 —— 留一点动作自带的嘴型,不至于完全被电平顶死
    if (this._lipsync && this._lipSyncIds.getSize() > 0) {
      for (let i = 0; i < this._lipSyncIds.getSize(); i += 1) {
        model.addParameterValueById(this._lipSyncIds.at(i), lipValue, 0.8);
      }
    }

    if (this._pose) this._pose.updateParameters(model, dt);
    model.update();
  }

  /** 画一帧。projection 会被就地乘上 modelMatrix(样例同语义,调用方每次新建)。 */
  public draw(projection: CubismMatrix44, canvas: HTMLCanvasElement): void {
    if (!this._ready || !this.getModel()) return;
    projection.multiplyByMatrix(this.getModelMatrix());
    const renderer = this.getRenderer();
    renderer.setMvpMatrix(projection);
    // vendor 签名把 fbo 标成非空,但绑到默认帧缓冲(画布)必须传 null
    renderer.setRenderState(null as unknown as WebGLFramebuffer, [0, 0, canvas.width, canvas.height]);
    renderer.drawModel();
  }

  /** 只释放 GL/模型资源;Framework 单例保持存活(见文件头铁律)。 */
  public override release(): void {
    this._ready = false;
    this._motions.clear();
    this._expressions.clear();
    super.release();
  }

  public releaseTextures(gl: GLContext | null): void {
    if (gl) for (const texture of this._textures) gl.deleteTexture(texture);
    this._textures = [];
  }
}

export type Live2DHostOptions = {
  canvas: HTMLCanvasElement;
  character: Live2DCharacter;
  /** 每帧取一次口型电平(原始 RMS 0..~0.4);返回 0 表示此刻没在出声。 */
  getAudioLevel: () => number;
  /** GL 上下文丢失等不可恢复故障:面板据此显示重试。 */
  onFatal?: (error: Error) => void;
  /** 首帧画完(面板用它撤掉骨架/加载态)。 */
  onFirstFrame?: () => void;
  /** 命中区域被点击。 */
  onTap?: (area: "head" | "body" | "none") => void;
  /** 口型增益:RMS → 0..1 的放大倍数。 */
  lipGain?: number;
};

/**
 * 一个 canvas 上的数字人运行时:GL 上下文 + 模型 + rAF 循环 + 指针交互 + 口型。
 *
 * 用法:`await Live2DHost.create({canvas, character, getAudioLevel})` → `host.release()`。
 */
export class Live2DHost {
  private constructor(
    private readonly options: Live2DHostOptions,
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: GLContext,
    private readonly model: AvatarModel,
  ) {}

  private readonly viewMatrix = new CubismViewMatrix();
  private readonly deviceToScreen = new CubismMatrix44();
  private readonly projection = new CubismMatrix44();

  private raf = 0;
  private lastTime = 0;
  private needResize = true;
  private disposed = false;
  private firstFrameFired = false;
  private paused = false;
  /** 上下文丢失是否已上报(见 renderFrame:静默 return 会把面板卡死在加载态)。 */
  private lostReported = false;

  /** 口型包络的当前值(状态)。推进逻辑在 lip.ts::lipEnvelope(纯函数,可单测)。 */
  private lipEnvelope = 0;

  private pointerCaptured = false;
  private pointerId: number | null = null;
  private pointerDownAt = 0;
  private pointerDownPos = { x: 0, y: 0 };
  private resizeObserver: ResizeObserver | null = null;
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.stopLoop();
    this.options.onFatal?.(new Error("WebGL context lost"));
  };
  private readonly onContextRestored = (): void => {
    // 上下文恢复后纹理/renderer 全是野指针:交给上层重建整个 host(资产已在缓存)
    this.options.onFatal?.(new Error("WebGL context restored; reload avatar"));
  };

  public static async create(options: Live2DHostOptions): Promise<Live2DHost> {
    const canvas = options.canvas;
    const gl = (canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    }) ??
      canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
      })) as GLContext | null;
    if (!gl) throw new Error("WebGL is not available in this browser");

    const model = new AvatarModel();
    let host: Live2DHost;
    try {
      await model.setup(options.character, gl);
      host = new Live2DHost(options, canvas, gl, model);
    } catch (error) {
      model.releaseTextures(gl);
      try {
        model.release();
      } catch {
        /* 装配中途失败:能释放多少算多少 */
      }
      throw error;
    }
    host.attach();
    host.startLoop();
    return host;
  }

  /** 绑事件与尺寸观察。 */
  private attach(): void {
    this.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        // 只在帧循环里处理尺寸:布局期间改 canvas.width 会引发同步重排
        this.needResize = true;
      });
      observer.observe(this.canvas);
      this.resizeObserver = observer;
    }
    this.resize();
  }

  private detach(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.resizeObserver?.disconnect();
  }

  /** 设备像素尺寸 + 视口 + 视图矩阵(逻辑坐标 [-1,1])。 */
  private resize(): void {
    const dpr = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);

    const ratio = width / height;
    this.viewMatrix.setScreenRect(-ratio, ratio, -1, 1);
    this.viewMatrix.scale(1, 1);
    this.viewMatrix.setMaxScale(2);
    this.viewMatrix.setMinScale(0.8);
    this.viewMatrix.setMaxScreenRect(-2, 2, -2, 2);

    this.deviceToScreen.loadIdentity();
    if (width > height) {
      const screenW = Math.abs(2 * ratio);
      this.deviceToScreen.scaleRelative(screenW / width, -screenW / width);
    } else {
      const screenH = 2;
      this.deviceToScreen.scaleRelative(screenH / height, -screenH / height);
    }
    this.deviceToScreen.translateRelative(-width * 0.5, -height * 0.5);
  }

  /** canvas 内的 CSS 坐标 → 设备像素。 */
  private devicePoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  /** 设备像素 → view 坐标(命中测试与拖拽都用它)。 */
  private viewPoint(deviceX: number, deviceY: number): { x: number; y: number } {
    return {
      x: this.viewMatrix.invertTransformX(this.deviceToScreen.transformX(deviceX)),
      y: this.viewMatrix.invertTransformY(this.deviceToScreen.transformY(deviceY)),
    };
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerCaptured = true;
    this.pointerId = event.pointerId;
    this.pointerDownAt = event.timeStamp;
    const device = this.devicePoint(event.clientX, event.clientY);
    this.pointerDownPos = device;
    const view = this.viewPoint(device.x, device.y);
    this.model.setDragging(view.x, view.y);
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pointerCaptured) return;
    const device = this.devicePoint(event.clientX, event.clientY);
    const view = this.viewPoint(device.x, device.y);
    this.model.setDragging(view.x, view.y);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.pointerCaptured) return;
    this.pointerCaptured = false;
    this.pointerId = null;
    this.model.setDragging(0, 0);
    const device = this.devicePoint(event.clientX, event.clientY);
    const moved = Math.hypot(device.x - this.pointerDownPos.x, device.y - this.pointerDownPos.y);
    const quick = event.timeStamp - this.pointerDownAt < 500;
    if (moved > 12 || !quick) return;
    const view = this.viewPoint(device.x, device.y);
    if (this.model.hitTest(HIT_HEAD, view.x, view.y)) {
      this.model.setRandomExpression();
      this.options.onTap?.("head");
    } else if (this.model.hitTest(HIT_BODY, view.x, view.y)) {
      this.model.startRandomMotion(MOTION_GROUP_TAP_BODY, PRIORITY_NORMAL);
      this.options.onTap?.("body");
    } else {
      this.options.onTap?.("none");
    }
  };

  private startLoop(): void {
    this.lastTime = 0;
    const tick = (now: number): void => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      if (this.paused) {
        // 暂停期间不推进也不绘制,但要把时钟丢掉:否则恢复时 dt 是整段暂停时长,
        // 物理与动作会一次性跳飞(MAX_DELTA 只夹单帧,夹不住「补帧」的冲动)。
        this.lastTime = 0;
        return;
      }
      const dt = this.lastTime === 0 ? 1 / 60 : Math.min(MAX_DELTA, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.renderFrame(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** 口型电平:原始 RMS → 增益 → 快起慢落包络 → 0..1(算法在 lip.ts,有单测)。
   *
   *  ⛔ getAudioLevel 是调用方给的回调(读引擎的 analyser),它可能抛
   *    (上下文被关、隐私模式):口型失败不许连累帧循环,吞掉按静音处理。 */
  private nextLipValue(dt: number): number {
    let raw = 0;
    try {
      raw = this.options.getAudioLevel();
    } catch {
      raw = 0;
    }
    this.lipEnvelope = lipEnvelope(this.lipEnvelope, raw, dt, this.options.lipGain);
    return this.lipEnvelope;
  }

  private renderFrame(dt: number): void {
    const gl = this.gl;
    // ⛔ 上下文丢了必须**报错**,不能静默 return:webglcontextlost 事件不一定
    //   派发到(切换角色时 canvas 被复用、或 GPU 在事件之前就重置),而首帧回调
    //   是面板撤掉加载态的唯一信号 —— 静默 return 就是永久卡在加载条上。
    if (gl.isContextLost()) {
      if (!this.lostReported) {
        this.lostReported = true; // 只报一次:面板已进 error 态,重复报没意义
        this.stopLoop();
        this.options.onFatal?.(new Error("WebGL context lost"));
      }
      return;
    }
    if (this.needResize) {
      this.resize();
      this.needResize = false;
    }

    const lip = this.nextLipValue(dt);
    this.model.updateFrame(dt, lip);

    const { width, height } = this.canvas;
    this.projection.loadIdentity();
    const canvasModel = this.model.getModel();
    if (canvasModel.getCanvasWidth() > 1.0 && width < height) {
      // 横向模型放进竖长画布:按宽度定标,否则会被裁掉两边
      this.model.getModelMatrix().setWidth(2.0);
      this.projection.scale(1.0, width / height);
    } else {
      this.projection.scale(height / width, 1.0);
    }
    this.projection.multiplyByMatrix(this.viewMatrix);

    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.clearDepth(1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.model.draw(this.projection, this.canvas);

    if (!this.firstFrameFired) {
      this.firstFrameFired = true;
      this.options.onFirstFrame?.();
    }
  }

  /** 外部触发一次动作(面板上的「打招呼」按钮)。 */
  public playMotion(group: string = MOTION_GROUP_TAP_BODY, priority: number = PRIORITY_NORMAL): boolean {
    return this.model.startRandomMotion(group, priority) !== InvalidMotionQueueEntryHandleValue;
  }

  /**
   * 播**指定的**那一条动作(舞台菜单里的具名条目)。
   *
   * 默认 PRIORITY_FORCE:用户点名要看的动作必须真的播出来。NORMAL 要先过
   * `reserveMotion`,而 idle 循环刚起的那条也是 NORMAL,点了会静默失败 ——
   * 菜单上明明点了「深鞠躬」她却毫无反应,比报错更难查。
   */
  public playMotionAt(group: string, index: number, priority: number = PRIORITY_FORCE): boolean {
    return this.model.startMotion(group, index, priority) !== InvalidMotionQueueEntryHandleValue;
  }

  public setExpression(name: string): void {
    this.model.setExpression(name);
  }

  public setRandomExpression(): void {
    this.model.setRandomExpression();
  }

  /** 角色是否声明了这个命中区域(用来决定要不要提示「点我试试」)。 */
  public hasHitArea(name: "head" | "body"): boolean {
    const setting = (this.model as unknown as { _setting: ICubismModelSetting | null })._setting;
    if (!setting) return false;
    const target = name === "head" ? HIT_HEAD : HIT_BODY;
    for (let i = 0; i < setting.getHitAreasCount(); i += 1) {
      if (setting.getHitAreaName(i) === target) return true;
    }
    return false;
  }

  /**
   * 放弃当前指针但**不**判定为 tap:窗口拖拽越过阈值后接管,模型该松手,
   * 头部跟随与点击命中都不该继续吃这条指针。
   *
   * ⛔ 不要改成「向 canvas 派发一个合成 pointercancel」——上层的窗口拖拽
   * 监听同样挂在 window 上,自己派发的事件会被自己的 pointerup/cancel 分支
   * 收到,拖拽在第一次跟手之后当场结束(macOS 上表现为「完全拖不动」)。
   * 直接改状态是唯一不误伤自己的做法。
   */
  public cancelPointer(): void {
    if (!this.pointerCaptured) return;
    this.pointerCaptured = false;
    const id = this.pointerId;
    this.pointerId = null;
    this.model.setDragging(0, 0);
    if (id !== null) {
      try {
        this.canvas.releasePointerCapture?.(id);
      } catch {
        /* 从未捕获 */
      }
    }
  }

  /**
   * 暂停/恢复帧循环(面板最小化、标签页不可见时用)。
   *
   * 不释放任何 GL 资源:恢复即继续画,避免「最小化 → 重建 host」反复创建/丢失
   * WebGL 上下文(每页上下文数量有上限,反复 lose/restore 在移动端最容易崩)。
   */
  public setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    if (!paused) {
      this.lastTime = 0;
      this.needResize = true;
    }
  }

  /** 口型参数当前值(自检/测试用)。 */
  public get lipLevel(): number {
    return this.model.lipValue;
  }

  public release(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.detach();
    this.model.releaseTextures(this.gl);
    try {
      this.model.release();
    } catch {
      /* 上下文已丢时释放会抛:忽略 */
    }
    // 主动归还上下文:面板可能反复开关,浏览器每页 WebGL 上下文有上限
    const lose = this.gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
  }
}
