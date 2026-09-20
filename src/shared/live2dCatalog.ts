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
// Bundle rev v1; characters: HaruGreeter, Mao, Hiyori, Chitose, Tsumiki, Epsilon, Hibiki, Rice.
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
    },
    {
      "id": "Hiyori",
      "labelZh": "日和",
      "labelEn": "Hiyori",
      "blurbZh": "安静的邻家少女,凝视与皱眉的小动作细腻,适合长时间陪伴。",
      "blurbEn": "A quiet girl next door; subtle gazes and small frowns, good company for long sessions.",
      "model3Url": "/models/live2d/v1/Hiyori/Hiyori.model3.json",
      "model3Bytes": 1100,
      "previewUrl": "/models/live2d/v1/Hiyori/preview.webp",
      "thumbUrl": "/models/live2d/v1/Hiyori/thumb.webp",
      "bytes": 1050153,
      "motionGroups": {
        "Idle": 1,
        "TapBody": 2
      },
      "expressions": [],
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
          "label": "难过-皱眉.motion3"
        },
        {
          "group": "TapBody",
          "index": 1,
          "slug": "m-tapbody-01.motion3.json",
          "label": "无聊-抬头望天摇摆.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/Hiyori/Hiyori.moc3",
          "bytes": 443648
        },
        {
          "url": "/models/live2d/v1/Hiyori/Hiyori.model3.json",
          "bytes": 1100
        },
        {
          "url": "/models/live2d/v1/Hiyori/Hiyori.physics3.json",
          "bytes": 26160
        },
        {
          "url": "/models/live2d/v1/Hiyori/Hiyori.pose3.json",
          "bytes": 166
        },
        {
          "url": "/models/live2d/v1/Hiyori/Hiyori.userdata3.json",
          "bytes": 623
        },
        {
          "url": "/models/live2d/v1/Hiyori/motions/m-idle-00.motion3.json",
          "bytes": 10622
        },
        {
          "url": "/models/live2d/v1/Hiyori/motions/m-tapbody-00.motion3.json",
          "bytes": 8772
        },
        {
          "url": "/models/live2d/v1/Hiyori/motions/m-tapbody-01.motion3.json",
          "bytes": 12732
        },
        {
          "url": "/models/live2d/v1/Hiyori/preview.webp",
          "bytes": 7038
        },
        {
          "url": "/models/live2d/v1/Hiyori/textures/texture_00.webp",
          "bytes": 234596
        },
        {
          "url": "/models/live2d/v1/Hiyori/textures/texture_01.webp",
          "bytes": 302912
        },
        {
          "url": "/models/live2d/v1/Hiyori/thumb.webp",
          "bytes": 1784
        }
      ]
    },
    {
      "id": "Chitose",
      "labelZh": "千岁",
      "labelEn": "Chitose",
      "blurbZh": "清爽的短发少女,挥手与指引手势利落,表情齐全。",
      "blurbEn": "A brisk short-haired girl with clean waves and guiding gestures, and a full expression set.",
      "model3Url": "/models/live2d/v1/Chitose/Chitose.model3.json",
      "model3Bytes": 1542,
      "previewUrl": "/models/live2d/v1/Chitose/preview.webp",
      "thumbUrl": "/models/live2d/v1/Chitose/thumb.webp",
      "bytes": 571206,
      "motionGroups": {
        "Idle": 1,
        "TapBody": 3
      },
      "expressions": [
        "angry",
        "blushing",
        "embarrass",
        "smile",
        "sad",
        "happy",
        "surprised"
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
          "label": "微笑-向左指引.motion3"
        },
        {
          "group": "TapBody",
          "index": 1,
          "slug": "m-tapbody-01.motion3.json",
          "label": "打招呼-挥手.motion3"
        },
        {
          "group": "TapBody",
          "index": 2,
          "slug": "m-tapbody-02.motion3.json",
          "label": "微笑-插单手.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/Chitose/Chitose.model3.json",
          "bytes": 1542
        },
        {
          "url": "/models/live2d/v1/Chitose/chitose.moc3",
          "bytes": 270656
        },
        {
          "url": "/models/live2d/v1/Chitose/chitose.physics3.json",
          "bytes": 3257
        },
        {
          "url": "/models/live2d/v1/Chitose/chitose.pose3.json",
          "bytes": 226
        },
        {
          "url": "/models/live2d/v1/Chitose/expressions/e-angry.exp3.json",
          "bytes": 1431
        },
        {
          "url": "/models/live2d/v1/Chitose/expressions/e-blushing.exp3.json",
          "bytes": 1452
        },
        {
          "url": "/models/live2d/v1/Chitose/expressions/e-embarrass.exp3.json",
          "bytes": 1436
        },
        {
          "url": "/models/live2d/v1/Chitose/expressions/e-happy.exp3.json",
          "bytes": 1413
        },
        {
          "url": "/models/live2d/v1/Chitose/expressions/e-sad.exp3.json",
          "bytes": 1447
        },
        {
          "url": "/models/live2d/v1/Chitose/expressions/e-smile.exp3.json",
          "bytes": 1411
        },
        {
          "url": "/models/live2d/v1/Chitose/expressions/e-surprised.exp3.json",
          "bytes": 1437
        },
        {
          "url": "/models/live2d/v1/Chitose/motions/m-idle-00.motion3.json",
          "bytes": 23856
        },
        {
          "url": "/models/live2d/v1/Chitose/motions/m-tapbody-00.motion3.json",
          "bytes": 11333
        },
        {
          "url": "/models/live2d/v1/Chitose/motions/m-tapbody-01.motion3.json",
          "bytes": 12175
        },
        {
          "url": "/models/live2d/v1/Chitose/motions/m-tapbody-02.motion3.json",
          "bytes": 14316
        },
        {
          "url": "/models/live2d/v1/Chitose/preview.webp",
          "bytes": 7840
        },
        {
          "url": "/models/live2d/v1/Chitose/textures/texture_00.webp",
          "bytes": 214018
        },
        {
          "url": "/models/live2d/v1/Chitose/thumb.webp",
          "bytes": 1960
        }
      ]
    },
    {
      "id": "Tsumiki",
      "labelZh": "紬木",
      "labelEn": "Tsumiki",
      "blurbZh": "怯生生的大小姐形象,表情最丰富(十种),眨眼动作轻柔。",
      "blurbEn": "A shy young lady with the richest expression set (ten faces) and a gentle blink.",
      "model3Url": "/models/live2d/v1/Tsumiki/Tsumiki.model3.json",
      "model3Bytes": 1686,
      "previewUrl": "/models/live2d/v1/Tsumiki/preview.webp",
      "thumbUrl": "/models/live2d/v1/Tsumiki/thumb.webp",
      "bytes": 1007960,
      "motionGroups": {
        "Idle": 1,
        "TapBody": 1
      },
      "expressions": [
        "angry",
        "blushing",
        "sad",
        "wigged",
        "happy-01",
        "happy-01",
        "smile",
        "surprised",
        "speechless",
        "embarrass"
      ],
      "motions": [
        {
          "group": "Idle",
          "index": 0,
          "slug": "m-idle-00.motion3.json",
          "label": "微笑-眨眼.motion3"
        },
        {
          "group": "TapBody",
          "index": 0,
          "slug": "m-tapbody-00.motion3.json",
          "label": "微笑-看着你.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/Tsumiki/Tsumiki.model3.json",
          "bytes": 1686
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-angry.exp3.json",
          "bytes": 1367
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-blushing.exp3.json",
          "bytes": 1371
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-embarrass.exp3.json",
          "bytes": 1374
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-happy-01.exp3.json",
          "bytes": 1144
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-happy-01.exp3.json",
          "bytes": 1352
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-sad.exp3.json",
          "bytes": 1236
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-smile.exp3.json",
          "bytes": 1349
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-speechless.exp3.json",
          "bytes": 1303
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-surprised.exp3.json",
          "bytes": 1357
        },
        {
          "url": "/models/live2d/v1/Tsumiki/expressions/e-wigged.exp3.json",
          "bytes": 1362
        },
        {
          "url": "/models/live2d/v1/Tsumiki/motions/m-idle-00.motion3.json",
          "bytes": 12818
        },
        {
          "url": "/models/live2d/v1/Tsumiki/motions/m-tapbody-00.motion3.json",
          "bytes": 18827
        },
        {
          "url": "/models/live2d/v1/Tsumiki/preview.webp",
          "bytes": 9256
        },
        {
          "url": "/models/live2d/v1/Tsumiki/textures/texture_00.webp",
          "bytes": 324618
        },
        {
          "url": "/models/live2d/v1/Tsumiki/textures/texture_01.webp",
          "bytes": 230242
        },
        {
          "url": "/models/live2d/v1/Tsumiki/thumb.webp",
          "bytes": 2378
        },
        {
          "url": "/models/live2d/v1/Tsumiki/tsumiki.moc3",
          "bytes": 384768
        },
        {
          "url": "/models/live2d/v1/Tsumiki/tsumiki.physics3.json",
          "bytes": 10152
        }
      ]
    },
    {
      "id": "Epsilon",
      "labelZh": "艾普西",
      "labelEn": "Epsilon",
      "blurbZh": "沉静的银发少女,生气与皱眉的小脾气动作很有性格。",
      "blurbEn": "A composed silver-haired girl whose little pouts and frowns give her real character.",
      "model3Url": "/models/live2d/v1/Epsilon/Epsilon.model3.json",
      "model3Bytes": 1758,
      "previewUrl": "/models/live2d/v1/Epsilon/preview.webp",
      "thumbUrl": "/models/live2d/v1/Epsilon/thumb.webp",
      "bytes": 589015,
      "motionGroups": {
        "Idle": 1,
        "TapBody": 2
      },
      "expressions": [
        "angry",
        "blushing",
        "innocent",
        "sad",
        "smile",
        "happy",
        "scare",
        "upset"
      ],
      "motions": [
        {
          "group": "Idle",
          "index": 0,
          "slug": "m-idle-00.motion3.json",
          "label": "微笑-平淡.motion3"
        },
        {
          "group": "TapBody",
          "index": 0,
          "slug": "m-tapbody-00.motion3.json",
          "label": "生气-叉手.motion3"
        },
        {
          "group": "TapBody",
          "index": 1,
          "slug": "m-tapbody-01.motion3.json",
          "label": "生气-皱眉.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/Epsilon/Epsilon.moc3",
          "bytes": 221824
        },
        {
          "url": "/models/live2d/v1/Epsilon/Epsilon.model3.json",
          "bytes": 1758
        },
        {
          "url": "/models/live2d/v1/Epsilon/Epsilon.physics3.json",
          "bytes": 3664
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-angry.exp3.json",
          "bytes": 1084
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-blushing.exp3.json",
          "bytes": 1011
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-happy.exp3.json",
          "bytes": 543
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-innocent.exp3.json",
          "bytes": 1090
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-sad.exp3.json",
          "bytes": 756
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-scare.exp3.json",
          "bytes": 814
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-smile.exp3.json",
          "bytes": 51
        },
        {
          "url": "/models/live2d/v1/Epsilon/expressions/e-upset.exp3.json",
          "bytes": 765
        },
        {
          "url": "/models/live2d/v1/Epsilon/motions/m-idle-00.motion3.json",
          "bytes": 12430
        },
        {
          "url": "/models/live2d/v1/Epsilon/motions/m-tapbody-00.motion3.json",
          "bytes": 9187
        },
        {
          "url": "/models/live2d/v1/Epsilon/motions/m-tapbody-01.motion3.json",
          "bytes": 13096
        },
        {
          "url": "/models/live2d/v1/Epsilon/preview.webp",
          "bytes": 11334
        },
        {
          "url": "/models/live2d/v1/Epsilon/textures/texture_00.webp",
          "bytes": 132644
        },
        {
          "url": "/models/live2d/v1/Epsilon/textures/texture_01.webp",
          "bytes": 97740
        },
        {
          "url": "/models/live2d/v1/Epsilon/textures/texture_02.webp",
          "bytes": 76156
        },
        {
          "url": "/models/live2d/v1/Epsilon/thumb.webp",
          "bytes": 3068
        }
      ]
    },
    {
      "id": "Hibiki",
      "labelZh": "响",
      "labelEn": "Hibiki",
      "blurbZh": "元气短发少女,从生气到无辜的一张脸转变是她的招牌动作。",
      "blurbEn": "A spirited short-haired girl; her signature move is turning from annoyed to innocent.",
      "model3Url": "/models/live2d/v1/Hibiki/Hibiki.model3.json",
      "model3Bytes": 1168,
      "previewUrl": "/models/live2d/v1/Hibiki/preview.webp",
      "thumbUrl": "/models/live2d/v1/Hibiki/thumb.webp",
      "bytes": 527491,
      "motionGroups": {
        "TapBody": 1
      },
      "expressions": [
        "Angry",
        "Blushing",
        "coldness",
        "smile",
        "Sad",
        "Surprised"
      ],
      "motions": [
        {
          "group": "TapBody",
          "index": 0,
          "slug": "m-tapbody-00.motion3.json",
          "label": "生气-转无辜.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/Hibiki/Hibiki.model3.json",
          "bytes": 1168
        },
        {
          "url": "/models/live2d/v1/Hibiki/expressions/e-angry.exp3.json",
          "bytes": 936
        },
        {
          "url": "/models/live2d/v1/Hibiki/expressions/e-blushing.exp3.json",
          "bytes": 1025
        },
        {
          "url": "/models/live2d/v1/Hibiki/expressions/e-coldness.exp3.json",
          "bytes": 1016
        },
        {
          "url": "/models/live2d/v1/Hibiki/expressions/e-sad.exp3.json",
          "bytes": 953
        },
        {
          "url": "/models/live2d/v1/Hibiki/expressions/e-smile.exp3.json",
          "bytes": 933
        },
        {
          "url": "/models/live2d/v1/Hibiki/expressions/e-surprised.exp3.json",
          "bytes": 949
        },
        {
          "url": "/models/live2d/v1/Hibiki/hibiki.moc3",
          "bytes": 185344
        },
        {
          "url": "/models/live2d/v1/Hibiki/hibiki.physics3.json",
          "bytes": 4443
        },
        {
          "url": "/models/live2d/v1/Hibiki/motions/m-tapbody-00.motion3.json",
          "bytes": 6948
        },
        {
          "url": "/models/live2d/v1/Hibiki/preview.webp",
          "bytes": 8360
        },
        {
          "url": "/models/live2d/v1/Hibiki/textures/texture_00.webp",
          "bytes": 313180
        },
        {
          "url": "/models/live2d/v1/Hibiki/thumb.webp",
          "bytes": 2236
        }
      ]
    },
    {
      "id": "Rice",
      "labelZh": "莱斯",
      "labelEn": "Rice",
      "blurbZh": "会魔法的绿发学徒,点火与能量攻击动作带特效感。",
      "blurbEn": "A green-haired magic apprentice whose spark and blast gestures carry real flair.",
      "model3Url": "/models/live2d/v1/Rice/Rice.model3.json",
      "model3Bytes": 921,
      "previewUrl": "/models/live2d/v1/Rice/preview.webp",
      "thumbUrl": "/models/live2d/v1/Rice/thumb.webp",
      "bytes": 1394359,
      "motionGroups": {
        "Idle": 2,
        "TapBody": 2
      },
      "expressions": [],
      "motions": [
        {
          "group": "Idle",
          "index": 0,
          "slug": "m-idle-00.motion3.json",
          "label": "平淡.motion3"
        },
        {
          "group": "Idle",
          "index": 1,
          "slug": "m-idle-01.motion3.json",
          "label": "魔法-书点火.motion3"
        },
        {
          "group": "TapBody",
          "index": 0,
          "slug": "m-tapbody-00.motion3.json",
          "label": "魔法-小能量攻击.motion3"
        },
        {
          "group": "TapBody",
          "index": 1,
          "slug": "m-tapbody-01.motion3.json",
          "label": "魔法-大能量攻击.motion3"
        }
      ],
      "files": [
        {
          "url": "/models/live2d/v1/Rice/Rice.moc3",
          "bytes": 479104
        },
        {
          "url": "/models/live2d/v1/Rice/Rice.model3.json",
          "bytes": 921
        },
        {
          "url": "/models/live2d/v1/Rice/Rice.physics3.json",
          "bytes": 25513
        },
        {
          "url": "/models/live2d/v1/Rice/motions/m-idle-00.motion3.json",
          "bytes": 10165
        },
        {
          "url": "/models/live2d/v1/Rice/motions/m-idle-01.motion3.json",
          "bytes": 13541
        },
        {
          "url": "/models/live2d/v1/Rice/motions/m-tapbody-00.motion3.json",
          "bytes": 22819
        },
        {
          "url": "/models/live2d/v1/Rice/motions/m-tapbody-01.motion3.json",
          "bytes": 21062
        },
        {
          "url": "/models/live2d/v1/Rice/preview.webp",
          "bytes": 7392
        },
        {
          "url": "/models/live2d/v1/Rice/textures/texture_00.webp",
          "bytes": 270914
        },
        {
          "url": "/models/live2d/v1/Rice/textures/texture_01.webp",
          "bytes": 540882
        },
        {
          "url": "/models/live2d/v1/Rice/thumb.webp",
          "bytes": 2046
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

/**
 * What to warm at boot: Core plus the character the config points at.
 *
 * Warming `LIVE2D_KEEP_URLS` used to be right while the bundle was two
 * characters; with eight it would pull ~8MB on every cold launch for faces
 * the user may never wear. The picker downloads any other character on
 * demand, behind the same honest progress bar the first run shows.
 */
export function prewarmUrls(characterId: string): string[] {
  const character = findLive2DCharacter(characterId) ?? LIVE2D_CATALOG.characters[0];
  return [LIVE2D_CATALOG.coreUrl, ...character.files.map((f) => f.url)];
}
