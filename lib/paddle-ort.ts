const ortJsepModulePath = "/vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs";
const ortJsepWasmPath = "/vendor/onnxruntime/ort-wasm-simd-threaded.jsep.wasm";

type OrtWasmPathMap = {
  mjs: string;
  wasm: string;
};

let moduleBlobUrlPromise: Promise<string> | null = null;

export async function getPaddleOrtWasmPaths(fetchModule: typeof fetch = fetch): Promise<string> {
  moduleBlobUrlPromise ??= fetchModule(ortJsepModulePath).then(async (response) => {
    if (!response.ok) {
      throw new Error(`ONNX Runtime 모듈을 불러오지 못했습니다. (${response.status})`);
    }

    const source = await response.arrayBuffer();
    return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  });

  const paths: OrtWasmPathMap = {
    mjs: await moduleBlobUrlPromise,
    wasm: ortJsepWasmPath,
  };

  // paddleocr-js types wasmPaths as a string, while its bundled ORT runtime
  // also accepts an explicit module/WASM URL map.
  return paths as unknown as string;
}
