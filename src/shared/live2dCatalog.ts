// GENERATED in robotworld by frontend/scripts/build_live2d_assets.py, copied here
// verbatim -- do not edit by hand (re-run the generator and re-copy instead).
//
// Live2D digital-human asset catalog. Every entry carries its exact byte size so
// the loader can show honest download progress and tell a truncated local copy
// from a complete one without a network round trip (see main/assets.ts, which
// serves these paths over the private `cw-asset:` scheme).
//
// Lives in `shared` because both sides need it: the renderer draws the models,
// and main pre-warms the on-disk cache at boot.
//
// Bundle rev v1; characters: HaruGreeter, Mao.
export type Live2DAssetFile = { url: string; bytes: number };

export type Live2DMotionRef = {
  /** Motion group name as used by the Cubism framework (`Idle`, `TapBody`). */
  group: string;
  /** Index inside that group. */
  index: number;
  slug: string;
  /** Original (Chinese) motion name, shown in the UI. */
  label: string;
};

export type Live2DCharacter = {
  id: string;
  labelZh: string;
  labelEn: string;
  blurbZh: string;
  blurbEn: string;
  model3Url: string;
  model3Bytes: number;
  previewUrl: string | null;
  thumbUrl: string | null;
  /** Sum of every shipped file, in bytes (download progress denominator). */
  bytes: number;
  motionGroups: Record<string, number>;
  expressions: string[];
  motions: Live2DMotionRef[];
  files: Live2DAssetFile[];
};

export type Live2DCatalog = {
  rev: string;
  /** Cubism Core runtime (Emscripten UMD). Loaded once via a blob script tag. */
  coreUrl: string;
  coreBytes: number;
  characters: Live2DCharacter[];
};

export const LIVE2D_CATALOG: Live2DCatalog = {
  "rev": "v1",
  "coreUrl": "/models/live2d/core/live2dcubismcore.v1.min.js",
  "coreBytes": 206678,
  "characters": [
    {
      "id": "HaruGreeter",
      "labelZh": "晴 · 引导",
      "labelEn": "Haru Greeter",
      "blurbZh": "礼貌的接待员形象,鞠躬与指引手势丰富,适合朗读陪伴。",
      "blurbEn": "A polite greeter with bows and guiding gestures; good company for read-aloud.",
      "model3Url": "/models/live2d/v1/HaruGreeter/HaruGreeter.model3.json",
      "model3Bytes": 5263,
      "previewUrl": "/models/live2d/v1/HaruGreeter/preview.webp",
      "thumbUrl": "/models/live2d/v1/HaruGreeter/thumb.webp",
      "bytes": 1384749,
      "motionGroups": {
        "Idle": 1,
        "TapBody": 27
      },
      "expressions": [
        "smile",
        "happy-01",
        "angry",
        "sad",
        "happy-02",
        "surprise",
        "shy",
        "coldness"
      ],
      "motions": [
        {
          "group": "Idle",
          "index": 0,
          "slug": "m-idle-00.motion3.json",
          "label": "微笑-正常.motion3"
        },
        {
          "group": "TapBody",
          "index": 0,
          "slug": "m-tapbody-00.motion3.json",
          "label": "俏皮-微微摇头.motion3"
        },
        {
          "group": "TapBody",
          "index": 1,
          "slug": "m-tapbody-01.motion3.json",
          "label": "否定-微微摇头.motion3"
        },
        {
          "group": "TapBody",
          "index": 2,
          "slug": "m-tapbody-02.motion3.json",
          "label": "否定-摆双手摇头.motion3"
        },
        {
          "group": "TapBody",
          "index": 3,
          "slug": "m-tapbody-03.motion3.json",
          "label": "微笑-向前浅鞠躬.motion3"
        },
        {
          "group": "TapBody",
          "index": 4,
          "slug": "m-tapbody-04.motion3.json",
          "label": "微笑-向前深鞠躬.motion3"
        },
        {
          "group": "TapBody",
          "index": 5,
          "slug": "m-tapbody-05.motion3.json",
          "label": "微笑-抬手往右指引.motion3"
        },
        {
          "group": "TapBody",
          "index": 6,
          "slug": "m-tapbody-06.motion3.json",
          "label": "微笑-抬手往左指引.motion3"
        },
        {
          "group": "TapBody",
          "index": 7,
          "slug": "m-tapbody-07.motion3.json",
          "label": "微笑-正常.motion3"
        },
        {
          "group": "TapBody",
          "index": 8,
          "slug": "m-tapbody-08.motion3.json",
          "label": "微笑-点头.motion3"
        },
        {
          "group": "TapBody",
          "index": 9,
          "slug": "m-tapbody-09.motion3.json",
          "label": "微笑-背手点头.motion3"
        },
        {
          "group": "TapBody",
          "index": 10,
          "slug": "m-tapbody-10.motion3.json",
          "label": "惊吓-往后一仰.motion3"
        },
        {
          "group": "TapBody",
          "index": 11,
          "slug": "m-tapbody-11.motion3.json",
          "label": "惊吓-闭眼张开双手后瞪眼.motion3"
        },
        {
          "group": "TapBody",
          "index": 12,
          "slug": "m-tapbody-12.motion3.json",
          "label": "惊讶-叉手张嘴点头.motion3"
        },
        {
          "group": "TapBody",
          "index": 13,
          "slug": "m-tapbody-13.motion3.json",
          "label": "惊讶-双手放开.motion3"
        },
        {
          "group": "TapBody",
          "index": 14,
          "slug": "m-tapbody-14.motion3.json",
          "label": "惊讶-张开双手点头.motion3"
        },
        {
          "group": "TapBody",
          "index": 15,
          "slug": "m-tapbody-15.motion3.json",
          "label": "无奈-叉手点头.motion3"
        },
        {
          "group": "TapBody",
          "index": 16,
          "slug": "m-tapbody-16.motion3.json",
          "label": "生气-被惊后埋头看地.motion3"
        },
        {
          "group": "TapBody",
          "index": 17,
          "slug": "m-tapbody-17.motion3.json",
          "label": "疑惑-张开双手定睛狠狠往前一看.motion3"
        },
        {
          "group": "TapBody",
          "index": 18,
          "slug": "m-tapbody-18.motion3.json",
          "label": "疑惑-张开双手定睛轻微往前一看.motion3"
        },
        {
          "group": "TapBody",
          "index": 19,
          "slug": "m-tapbody-19.motion3.json",
          "label": "疑虑-手放嘴角.motion3"
        },
        {
          "group": "TapBody",
          "index": 20,
          "slug": "m-tapbody-20.motion3.json",
          "label": "脸红-眯眼埋头.motion3"
        },
        {
          "group": "TapBody",
          "index": 21,
          "slug": "m-tapbody-21.motion3.json",
          "label": "脸红-眯眼笑.motion3"
        },
        {
          "group": "TapBody",
          "index": 22,
          "slug": "m-tapbody-22.motion3.json",
          "label": "脸红-身体往前倾.motion3"
        },
        {
          "group": "TapBody",
          "index": 23,
          "slug": "m-tapbody-23.motion3.json",
          "label": "难过-双手放胸前.motion3"
        },
        {
          "group": "TapBody",
          "index": 24,
          "slug": "m-tapbody-24.motion3.json",
          "label": "难过-睁眼瘪嘴.motion3"
        },
        {
          "group": "TapBody",
          "index": 25,
          "slug": "m-tapbody-25.motion3.json",
          "label": "高兴-左右摇摆.motion3"
        },
        {
          "group": "TapBody",
          "index": 26,
          "slug": "m-tapbody-26.motion3.json",
          "label": "高兴-身体前倾眯眼.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/HaruGreeter/Haru.moc3",
          "bytes": 384704
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/Haru.physics3.json",
          "bytes": 5914
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/Haru.pose3.json",
          "bytes": 274
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/Haru.userdata3.json",
          "bytes": 313
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/HaruGreeter.model3.json",
          "bytes": 5263
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-angry.exp3.json",
          "bytes": 739
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-coldness.exp3.json",
          "bytes": 421
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-happy-01.exp3.json",
          "bytes": 464
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-happy-02.exp3.json",
          "bytes": 474
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-sad.exp3.json",
          "bytes": 841
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-shy.exp3.json",
          "bytes": 907
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-smile.exp3.json",
          "bytes": 124
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/expressions/e-surprise.exp3.json",
          "bytes": 475
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-idle-00.motion3.json",
          "bytes": 21183
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-00.motion3.json",
          "bytes": 13540
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-01.motion3.json",
          "bytes": 14475
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-02.motion3.json",
          "bytes": 22441
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-03.motion3.json",
          "bytes": 25066
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-04.motion3.json",
          "bytes": 15439
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-05.motion3.json",
          "bytes": 14821
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-06.motion3.json",
          "bytes": 15118
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-07.motion3.json",
          "bytes": 21183
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-08.motion3.json",
          "bytes": 11944
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-09.motion3.json",
          "bytes": 12055
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-10.motion3.json",
          "bytes": 23275
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-11.motion3.json",
          "bytes": 34954
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-12.motion3.json",
          "bytes": 23449
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-13.motion3.json",
          "bytes": 16695
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-14.motion3.json",
          "bytes": 14198
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-15.motion3.json",
          "bytes": 16981
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-16.motion3.json",
          "bytes": 18090
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-17.motion3.json",
          "bytes": 20625
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-18.motion3.json",
          "bytes": 11601
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-19.motion3.json",
          "bytes": 23651
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-20.motion3.json",
          "bytes": 11302
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-21.motion3.json",
          "bytes": 13424
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-22.motion3.json",
          "bytes": 16109
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-23.motion3.json",
          "bytes": 18639
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-24.motion3.json",
          "bytes": 17528
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-25.motion3.json",
          "bytes": 23906
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/motions/m-tapbody-26.motion3.json",
          "bytes": 27408
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/preview.webp",
          "bytes": 4406
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/textures/texture_00.webp",
          "bytes": 258236
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/textures/texture_01.webp",
          "bytes": 201006
        },
        {
          "url": "/models/live2d/v1/HaruGreeter/thumb.webp",
          "bytes": 1088
        }
      ]
    },
    {
      "id": "Mao",
      "labelZh": "真央",
      "labelEn": "Mao",
      "blurbZh": "活泼的画师少女,挥手与比心动作明快,表情层次细腻。",
      "blurbEn": "A lively artist girl with bright waves and heart gestures, plus nuanced expressions.",
      "model3Url": "/models/live2d/v1/Mao/Mao.model3.json",
      "model3Bytes": 1744,
      "previewUrl": "/models/live2d/v1/Mao/preview.webp",
      "thumbUrl": "/models/live2d/v1/Mao/thumb.webp",
      "bytes": 1535443,
      "motionGroups": {
        "Idle": 1,
        "TapBody": 3
      },
      "expressions": [
        "sad",
        "embarrass",
        "happy",
        "smile",
        "scare",
        "surprised",
        "angry",
        "blushing"
      ],
      "motions": [
        {
          "group": "Idle",
          "index": 0,
          "slug": "m-idle-00.motion3.json",
          "label": "微笑-看着你.motion3"
        },
        {
          "group": "TapBody",
          "index": 0,
          "slug": "m-tapbody-00.motion3.json",
          "label": "画画成功-爱心.motion3"
        },
        {
          "group": "TapBody",
          "index": 1,
          "slug": "m-tapbody-01.motion3.json",
          "label": "画画失败-爱心.motion3"
        },
        {
          "group": "TapBody",
          "index": 2,
          "slug": "m-tapbody-02.motion3.json",
          "label": "微笑-挥动双手.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/Mao/Mao.moc3",
          "bytes": 807488
        },
        {
          "url": "/models/live2d/v1/Mao/Mao.model3.json",
          "bytes": 1744
        },
        {
          "url": "/models/live2d/v1/Mao/Mao.physics3.json",
          "bytes": 21838
        },
        {
          "url": "/models/live2d/v1/Mao/Mao.pose3.json",
          "bytes": 254
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-angry.exp3.json",
          "bytes": 1997
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-blushing.exp3.json",
          "bytes": 2002
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-embarrass.exp3.json",
          "bytes": 2000
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-happy.exp3.json",
          "bytes": 2002
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-sad.exp3.json",
          "bytes": 2001
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-scare.exp3.json",
          "bytes": 2012
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-smile.exp3.json",
          "bytes": 1996
        },
        {
          "url": "/models/live2d/v1/Mao/expressions/e-surprised.exp3.json",
          "bytes": 2010
        },
        {
          "url": "/models/live2d/v1/Mao/motions/m-idle-00.motion3.json",
          "bytes": 25161
        },
        {
          "url": "/models/live2d/v1/Mao/motions/m-tapbody-00.motion3.json",
          "bytes": 31769
        },
        {
          "url": "/models/live2d/v1/Mao/motions/m-tapbody-01.motion3.json",
          "bytes": 39309
        },
        {
          "url": "/models/live2d/v1/Mao/motions/m-tapbody-02.motion3.json",
          "bytes": 21774
        },
        {
          "url": "/models/live2d/v1/Mao/preview.webp",
          "bytes": 10978
        },
        {
          "url": "/models/live2d/v1/Mao/textures/texture_00.webp",
          "bytes": 556286
        },
        {
          "url": "/models/live2d/v1/Mao/thumb.webp",
          "bytes": 2822
        }
      ]
    }
  ]
} as Live2DCatalog;

/** All asset URLs in the bundle (used to prune superseded cache entries). */
export const LIVE2D_KEEP_URLS: string[] = [
  LIVE2D_CATALOG.coreUrl,
  ...LIVE2D_CATALOG.characters.flatMap((c) => c.files.map((f) => f.url)),
];

/** Look up a character by id; undefined when the catalog does not ship it. */
export function findLive2DCharacter(id: string): Live2DCharacter | undefined {
  return LIVE2D_CATALOG.characters.find((c) => c.id === id);
}
