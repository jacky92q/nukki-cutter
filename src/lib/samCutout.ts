import {
  AutoProcessor,
  RawImage,
  SamModel,
  Tensor,
  env,
} from '@huggingface/transformers'

/**
 * AI 인식 누끼(promptable segmentation) 모듈.
 *
 * 사용자가 브러시로 대략 칠한 영역에서 박스/점 프롬프트를 뽑아 SAM(SlimSAM)에
 * 넘기면, 모델이 그 위치의 오브젝트 경계를 정확히 찾아 마스크를 만든다.
 * 추론은 전적으로 브라우저(WebGPU/WASM) 안에서 이루어지며 이미지는 외부로
 * 전송되지 않는다(모델 가중치만 최초 1회 다운로드).
 */

// 로컬 경로(/models)를 먼저 찾지 않고 곧바로 허브에서 모델을 받도록 한다.
env.allowLocalModels = false

const MODEL_ID = 'Xenova/slimsam-77-uniform'

/** 포함(1) / 제외(0) 점. 좌표는 정규화된 이미지 픽셀 기준. */
export interface SamPoint {
  x: number
  y: number
  label: 0 | 1
}

/** 박스. 좌표는 정규화된 이미지 픽셀 기준. */
export interface SamBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MaskResult {
  /** 픽셀당 0/1 */
  data: Uint8Array
  width: number
  height: number
}

type ModelBundle = { model: any; processor: any }
type LoadOption = { device?: 'webgpu' | 'wasm'; dtype?: 'fp16' | 'q8' }

let bundlePromise: Promise<ModelBundle> | null = null

/**
 * 시도할 백엔드 구성을 우선순위대로 만든다.
 * navigator.gpu 가 "존재"하기만 해서는 안 되고 실제 어댑터를 받을 수 있어야
 * WebGPU 를 시도한다(모바일은 gpu 객체만 있고 어댑터가 없는 경우가 흔함).
 * 어떤 구성이 실패해도 다음 구성으로 자동 폴백한다.
 */
async function resolveBackends(): Promise<LoadOption[]> {
  const attempts: LoadOption[] = []
  try {
    const gpu = (
      navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
    ).gpu
    if (gpu) {
      const adapter = await gpu.requestAdapter()
      if (adapter) attempts.push({ device: 'webgpu', dtype: 'fp16' })
    }
  } catch {
    /* WebGPU 확인 실패 시 무시하고 WASM 으로 진행 */
  }
  // q8(8비트 양자화)은 마스크 디코더가 노이즈를 내는 품질 문제가 있어 쓰지 않는다.
  // 기본값(fp32/WASM)은 약간 느리지만 정확도가 온전하고 어디서나 동작한다.
  attempts.push({})
  return attempts
}

/** 모델/프로세서를 한 번만 로드해 캐싱한다. 구성별로 순차 폴백한다. */
export function loadSam(
  onProgress?: (ratio: number) => void,
): Promise<ModelBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const progress_callback = (data: { status?: string; progress?: number }) => {
        if (data.status === 'progress' && onProgress) {
          onProgress((data.progress ?? 0) / 100)
        }
      }
      const attempts = await resolveBackends()
      let lastError: unknown
      for (const opts of attempts) {
        try {
          const model = await SamModel.from_pretrained(MODEL_ID, {
            ...opts,
            progress_callback,
          } as any)
          const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
            progress_callback,
          } as any)
          return { model, processor }
        } catch (err) {
          console.warn('[SAM] 로드 시도 실패:', opts, err)
          lastError = err
        }
      }
      throw lastError ?? new Error('AI 모델을 불러올 수 없습니다.')
    })()
    bundlePromise.catch(() => {
      bundlePromise = null // 실패 시 다음에 다시 시도할 수 있게
    })
  }
  return bundlePromise
}

/**
 * 한 장의 이미지를 위한 SAM 세션. 무거운 이미지 임베딩은 한 번만 계산해두고,
 * 프롬프트(점/박스)가 바뀔 때마다 가벼운 디코더만 다시 돌린다.
 */
export class SamSession {
  private model: any
  private processor: any
  private imageInputs: any
  private embeddings: any
  readonly width: number
  readonly height: number

  private constructor(
    model: any,
    processor: any,
    imageInputs: any,
    embeddings: any,
    width: number,
    height: number,
  ) {
    this.model = model
    this.processor = processor
    this.imageInputs = imageInputs
    this.embeddings = embeddings
    this.width = width
    this.height = height
  }

  static async create(
    input: Blob,
    onProgress?: (ratio: number) => void,
  ): Promise<SamSession> {
    const { model, processor } = await loadSam(onProgress)
    const image = await RawImage.read(input)
    const imageInputs = await processor(image)
    const embeddings = await model.get_image_embeddings(imageInputs)
    return new SamSession(
      model,
      processor,
      imageInputs,
      embeddings,
      image.width,
      image.height,
    )
  }

  /** 점/박스 프롬프트로 마스크를 계산한다. 이미지 크기의 0/1 마스크를 돌려준다. */
  async segment(points: SamPoint[], box: SamBox | null): Promise<MaskResult> {
    // 모델 입력 해상도(reshaped_input_sizes)는 [height, width].
    const reshaped = this.imageInputs.reshaped_input_sizes[0] as [number, number]
    const sx = reshaped[1] / this.width
    const sy = reshaped[0] / this.height

    const inputs: Record<string, unknown> = { ...this.embeddings }

    if (points.length > 0) {
      const coords: number[] = []
      const labels: bigint[] = []
      for (const p of points) {
        coords.push(p.x * sx, p.y * sy)
        labels.push(BigInt(p.label))
      }
      inputs.input_points = new Tensor('float32', coords, [1, 1, points.length, 2])
      inputs.input_labels = new Tensor('int64', labels, [1, 1, points.length])
    }

    if (box) {
      const coords = [box.x1 * sx, box.y1 * sy, box.x2 * sx, box.y2 * sy]
      inputs.input_boxes = new Tensor('float32', coords, [1, 1, 4])
    }

    const outputs = await this.model(inputs)
    const masks = await this.processor.post_process_masks(
      outputs.pred_masks,
      this.imageInputs.original_sizes,
      this.imageInputs.reshaped_input_sizes,
    )

    // masks[0]: bool 텐서, dims = [1, numMasks, H, W]. iou_scores 로 최적 마스크 선택.
    const mask = masks[0]
    const [, numMasks, h, w] = mask.dims as number[]
    const scores = outputs.iou_scores.data as Float32Array
    let best = 0
    for (let i = 1; i < numMasks; i++) {
      if (scores[i] > scores[best]) best = i
    }

    const all = mask.data as Uint8Array
    const out = new Uint8Array(h * w)
    const offset = best * h * w
    for (let i = 0; i < h * w; i++) out[i] = all[offset + i]

    // 사용자가 칠한 박스(+여유 8%) 밖은 잘라낸다 — 모델이 엉뚱한 곳에
    // 노이즈 마스크를 흩뿌려도 다른 오브젝트로 번지지 않게 하는 안전망.
    if (box) {
      const mx = (box.x2 - box.x1) * 0.08 + 4
      const my = (box.y2 - box.y1) * 0.08 + 4
      const cx1 = Math.max(0, Math.floor(box.x1 - mx))
      const cy1 = Math.max(0, Math.floor(box.y1 - my))
      const cx2 = Math.min(w - 1, Math.ceil(box.x2 + mx))
      const cy2 = Math.min(h - 1, Math.ceil(box.y2 + my))
      for (let y = 0; y < h; y++) {
        if (y < cy1 || y > cy2) {
          out.fill(0, y * w, y * w + w)
          continue
        }
        for (let x = 0; x < w; x++) {
          if (x < cx1 || x > cx2) out[y * w + x] = 0
        }
      }
    }

    return { data: out, width: w, height: h }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

/**
 * 마스크를 적용해 선택 영역만 남긴 투명 PNG Blob 을 만든다.
 * feather(px)만큼 외곽을 부드럽게 풀어 경계 품질을 높인다.
 */
export async function compositeCutout(
  sourceUrl: string,
  mask: MaskResult,
  feather = 1.5,
): Promise<Blob> {
  const { width: w, height: h } = mask
  const img = await loadImage(sourceUrl)

  // 1) 마스크를 흑백 캔버스로
  const mc = document.createElement('canvas')
  mc.width = w
  mc.height = h
  const mctx = mc.getContext('2d')!
  const mi = mctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    if (mask.data[i]) {
      mi.data[i * 4] = 255
      mi.data[i * 4 + 1] = 255
      mi.data[i * 4 + 2] = 255
      mi.data[i * 4 + 3] = 255
    }
  }
  mctx.putImageData(mi, 0, 0)

  // 2) 살짝 블러를 먹여 부드러운 알파 경계를 만든다
  const bc = document.createElement('canvas')
  bc.width = w
  bc.height = h
  const bctx = bc.getContext('2d')!
  if (feather > 0) bctx.filter = `blur(${feather}px)`
  bctx.drawImage(mc, 0, 0)
  const alpha = bctx.getImageData(0, 0, w, h).data

  // 3) 원본에 알파 적용
  const oc = document.createElement('canvas')
  oc.width = w
  oc.height = h
  const octx = oc.getContext('2d')!
  octx.drawImage(img, 0, 0, w, h)
  const od = octx.getImageData(0, 0, w, h)
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i * 4 + 3]
    if (a < od.data[i * 4 + 3]) od.data[i * 4 + 3] = a
  }
  octx.putImageData(od, 0, 0)

  return new Promise((resolve, reject) =>
    oc.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('PNG 생성 실패'))),
      'image/png',
    ),
  )
}
