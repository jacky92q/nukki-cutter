import {
  removeBackground,
  type Config,
} from '@imgly/background-removal'

/**
 * 누끼(배경 제거) 처리 모듈.
 *
 * @imgly/background-removal 은 ONNX 런타임 위에서 ISNet 세그멘테이션 모델을
 * 실행하며, 추론은 전적으로 브라우저(WebGPU 또는 WASM) 안에서 이루어진다.
 * 입력 이미지가 외부 서버로 전송되지 않으므로 보안이 중요한 환경에서도
 * 그대로 사용할 수 있다.
 */

export type Quality = 'best' | 'fast'

export interface ProgressInfo {
  /** 현재 단계 설명 (모델 다운로드 / 추론 등) */
  stage: string
  /** 0~1 사이의 진행률 */
  ratio: number
}

/** 품질 옵션 → 모델 매핑. */
const MODEL_BY_QUALITY: Record<Quality, NonNullable<Config['model']>> = {
  // isnet(fp32): 가장 정밀한 경계 표현. 머리카락/털 등 디테일에 강하다.
  best: 'isnet',
  // isnet_fp16: 절반 크기로 더 빠르게 다운로드/추론. 품질도 충분히 높다.
  fast: 'isnet_fp16',
}

function describeStage(key: string): string {
  if (key.startsWith('fetch')) return '모델 파일 불러오는 중'
  if (key.startsWith('compute') || key.startsWith('inference'))
    return '배경 분석 중'
  return '준비 중'
}

/**
 * 이미지에서 배경을 제거하고, 피사체만 남긴 투명 PNG Blob 을 돌려준다.
 *
 * @param input  처리할 이미지 (File / Blob / object URL)
 * @param quality 품질 옵션
 * @param onProgress 진행률 콜백
 */
export async function cutout(
  input: Blob,
  quality: Quality,
  onProgress?: (info: ProgressInfo) => void,
): Promise<Blob> {
  const config: Config = {
    model: MODEL_BY_QUALITY[quality],
    // 가능하면 GPU(WebGPU)를 사용하고, 미지원 환경에서는 자동으로 CPU(WASM)로 폴백.
    device: 'gpu',
    // removeBackground 는 피사체(전경)만 남기고 배경을 투명하게 만든 PNG 를 돌려준다.
    output: {
      format: 'image/png',
    },
    progress: (key, current, total) => {
      if (!onProgress) return
      const ratio = total > 0 ? current / total : 0
      onProgress({ stage: describeStage(key), ratio })
    },
  }

  return removeBackground(input, config)
}
