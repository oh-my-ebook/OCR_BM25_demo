#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC_DIR="$PROJECT_DIR/public"
VENDOR_DIR="$PUBLIC_DIR/vendor"
KIWI_DIR="$PUBLIC_DIR/kiwi"
ONNXRUNTIME_DIR="$VENDOR_DIR/onnxruntime"

DETECTION_URL="https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar"
KOREAN_MODEL_REVISION="5c6f574b8e2230adf4287b33e736d71b9fabd28e"
KOREAN_MODEL_BASE="https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/$KOREAN_MODEL_REVISION"
KIWI_VERSION="0.23.0"
KIWI_MODEL_URL="https://github.com/bab2min/Kiwi/releases/download/v${KIWI_VERSION}/kiwi_model_v${KIWI_VERSION}_base.tgz"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "필요한 명령을 찾을 수 없습니다: $1" >&2
    exit 1
  fi
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "필요한 npm 자산이 없습니다: $1" >&2
    echo "먼저 npm ci를 실행해 주세요." >&2
    exit 1
  fi
}

download() {
  local url="$1"
  local output="$2"
  echo "다운로드: $(basename "$output")"
  curl --fail --location --retry 3 --progress-bar "$url" --output "$output"
}

require_command curl
require_command tar

require_file "$PROJECT_DIR/node_modules/kiwi-nlp/dist/kiwi-wasm.wasm"
require_file "$PROJECT_DIR/node_modules/pdfjs-dist/build/pdf.worker.min.mjs"
require_file "$PROJECT_DIR/node_modules/sql.js/dist/sql-wasm.wasm"
require_file "$PROJECT_DIR/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs"
require_file "$PROJECT_DIR/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm"
require_file "$PROJECT_DIR/node_modules/tesseract.js/dist/worker.min.js"
require_file "$PROJECT_DIR/node_modules/tesseract.js-core/tesseract-core-lstm.wasm"
require_file "$PROJECT_DIR/node_modules/@tesseract.js-data/kor/4.0.0/kor.traineddata.gz"

mkdir -p \
  "$KIWI_DIR/model" \
  "$VENDOR_DIR/paddleocr" \
  "$VENDOR_DIR/pdfjs" \
  "$ONNXRUNTIME_DIR" \
  "$VENDOR_DIR/tesseract" \
  "$VENDOR_DIR/tessdata"

echo "npm 패키지에서 브라우저 런타임 복사"
cp "$PROJECT_DIR/node_modules/kiwi-nlp/dist/kiwi-wasm.wasm" "$KIWI_DIR/kiwi-wasm.wasm"
cp "$PROJECT_DIR/node_modules/pdfjs-dist/build/pdf.worker.min.mjs" "$VENDOR_DIR/pdf.worker.min.mjs"
cp -R "$PROJECT_DIR/node_modules/pdfjs-dist/cmaps" "$VENDOR_DIR/pdfjs/"
cp -R "$PROJECT_DIR/node_modules/pdfjs-dist/standard_fonts" "$VENDOR_DIR/pdfjs/"
cp -R "$PROJECT_DIR/node_modules/pdfjs-dist/wasm" "$VENDOR_DIR/pdfjs/"
cp "$PROJECT_DIR/node_modules/sql.js/dist/sql-wasm.wasm" "$VENDOR_DIR/sql-wasm.wasm"
cp "$PROJECT_DIR/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs" "$ONNXRUNTIME_DIR/"
cp "$PROJECT_DIR/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm" "$ONNXRUNTIME_DIR/"
cp "$PROJECT_DIR/node_modules/tesseract.js/dist/worker.min.js" "$VENDOR_DIR/tesseract/worker.min.js"

for core_name in \
  tesseract-core-lstm \
  tesseract-core-relaxedsimd-lstm \
  tesseract-core-simd-lstm
do
  cp "$PROJECT_DIR/node_modules/tesseract.js-core/${core_name}.wasm" "$VENDOR_DIR/tesseract/"
  cp "$PROJECT_DIR/node_modules/tesseract.js-core/${core_name}.wasm.js" "$VENDOR_DIR/tesseract/"
done

cp "$PROJECT_DIR/node_modules/@tesseract.js-data/kor/4.0.0/kor.traineddata.gz" "$VENDOR_DIR/tessdata/"
cp "$PROJECT_DIR/node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz" "$VENDOR_DIR/tessdata/"

DETECTION_TAR="$VENDOR_DIR/paddleocr/PP-OCRv5_mobile_det_onnx_infer.tar"
if [[ ! -s "$DETECTION_TAR" ]]; then
  download "$DETECTION_URL" "$DETECTION_TAR"
else
  echo "기존 PaddleOCR 탐지 모델 사용"
fi

KOREAN_TAR="$VENDOR_DIR/paddleocr/korean_PP-OCRv5_mobile_rec_onnx_infer.tar"
if [[ ! -s "$KOREAN_TAR" ]]; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  KOREAN_DIR="$TEMP_DIR/korean_PP-OCRv5_mobile_rec_onnx_infer"
  mkdir -p "$KOREAN_DIR"
  download "$KOREAN_MODEL_BASE/inference.onnx?download=true" "$KOREAN_DIR/inference.onnx"
  download "$KOREAN_MODEL_BASE/inference.yml?download=true" "$KOREAN_DIR/inference.yml"
  tar -cf "$KOREAN_TAR" -C "$TEMP_DIR" "$(basename "$KOREAN_DIR")"
else
  echo "기존 PaddleOCR 한국어 인식 모델 사용"
fi

KIWI_REQUIRED=(combiningRule.txt default.dict extract.mdl cong.mdl nounchr.mdl sj.morph)
KIWI_READY=true
for model_name in "${KIWI_REQUIRED[@]}"; do
  if [[ ! -s "$KIWI_DIR/model/$model_name" ]]; then
    KIWI_READY=false
    break
  fi
done

if [[ "$KIWI_READY" == false ]]; then
  TEMP_DIR="${TEMP_DIR:-$(mktemp -d)}"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  KIWI_ARCHIVE="$TEMP_DIR/kiwi-model.tgz"
  download "$KIWI_MODEL_URL" "$KIWI_ARCHIVE"
  tar -xzf "$KIWI_ARCHIVE" -C "$TEMP_DIR"
  KIWI_CONG_FILE="$(find "$TEMP_DIR" -type f -name cong.mdl -print -quit)"
  if [[ -z "$KIWI_CONG_FILE" ]]; then
    echo "Kiwi CoNg 모델 폴더를 찾지 못했습니다." >&2
    exit 1
  fi
  KIWI_SOURCE_DIR="$(dirname "$KIWI_CONG_FILE")"
  for model_name in "${KIWI_REQUIRED[@]}"; do
    require_file "$KIWI_SOURCE_DIR/$model_name"
    cp "$KIWI_SOURCE_DIR/$model_name" "$KIWI_DIR/model/$model_name"
  done
else
  echo "기존 Kiwi CoNg 모델 사용"
fi

echo "로컬 브라우저 자산 준비 완료"
