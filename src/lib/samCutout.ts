import {
  AutoProcessor,
  RawImage,
  SamModel,
  Tensor,
  env,
} from '@huggingface/transformers'

/**
 * 지정 누끼(promptable segmentation) 모듈.
 *
 * SAM(Segment Anything Model) 계열의 경량 모델 SlimSAM 을 브라우저(WebGPU/WASM)에서
 * 실행한다. 사용자가 찍은 점(포함/제외)이나 감싼 박스를 프롬프트로 받아, 해당 위치의
 * 오브젝트만 분할한 마스크를 만든다. 추론은 전적으로 브라우저 안에서 이루어지며
 * 이미지는 외부로 전송되지 않는다.
 */

// 로컬 경로(/models)를 먼저 찾지 않고 곧바로 Hugging Face 허브에서 모델을 받도록 한다.
env.allowLocalModels = false

const MODEL_ID = 'Xenova/slimsam-77-uniform'

/** 포함(1) / 제외(0) 점. 좌표는 원본 이미지 픽셀 기준. */
export interface SamPoint {
  x: number
  y: number
  label: 0 | 1
}

/** 박스. 좌표는 원본 이미지 픽셀 기준. */
export interface SamBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MaskResult {
  data: Uint8Array
  width: number
  height: number
}

type ModelBundle = { model: any; processor: any }

let bundlePromise: Promise<ModelBundle> | null = null

function pickBackend(): { device: 'webgpu' | 'wasm'; dtype: 'fp16' | 'q8' } {
  const hasGpu =
    typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu
  return hasGpu
    ? { device: 'webgpu', dtype: 'fp16' }
    : { device: 'wasm', dtype: 'q8' }
}

/** 모델/프로세서를 한 번만 로드해 캐싱한다. */
export function loadSam(onProgress?: (ratio: number) => void): Promise<ModelBundle> {
  if (!bundlePromise) {
    const { device, dtype } = pickBackend()
    bundlePromise = (async () => {
      const progress_callback = (data: { status?: string; progress?: number }) => {
        if (data.status === 'progress' && onProgress) {
          onProgress((data.progress ?? 0) / 100)
        }
      }
      const model = await SamModel.from_pretrained(MODEL_ID, {
        device,
        dtype,
        progress_callback,
      } as any)
      const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
        progress_callback,
      } as any)
      return { model, processor }
    })()
    // 실패 시 다음 시도에서 다시 로드할 수 있도록 캐시를 비운다.
    bundlePromise.catch(() => {
      bundlePromise = null
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
  /** 원본 이미지 크기(픽셀) */
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

  /** 점/박스 프롬프트로 마스크를 계산한다. 원본 이미지 크기의 0/1 마스크를 돌려준다. */
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

    // masks[0]: bool 텐서, dims = [1, numMasks, H, W]. iou_scores 로 가장 좋은 마스크 선택.
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
 * 마스크를 적용해 선택한 오브젝트만 남긴 투명 PNG Blob 을 만든다.
 * 마스크는 원본 이미지와 동일한 픽셀 크기다.
 */
export async function compositeCutout(
  sourceUrl: string,
  mask: MaskResult,
): Promise<Blob> {
  const img = await loadImage(sourceUrl)
  const canvas = document.createElement('canvas')
  canvas.width = mask.width
  canvas.height = mask.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context 를 만들 수 없습니다.')

  ctx.drawImage(img, 0, 0, mask.width, mask.height)
  const imageData = ctx.getImageData(0, 0, mask.width, mask.height)
  const data = imageData.data
  for (let i = 0; i < mask.width * mask.height; i++) {
    if (!mask.data[i]) data[i * 4 + 3] = 0
  }
  ctx.putImageData(imageData, 0, 0)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG 생성 실패'))),
      'image/png',
    )
  })
}
