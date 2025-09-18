import { parentPort, workerData } from "worker_threads";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gaborator = require(workerData.gaboratorPath);

if (!parentPort) {
  throw new Error("This script must be run as a worker thread.");
}

parentPort.on("message", async (args) => {
  try {
    const { processedData, analysisMetadata, sampleRate, params, normalize } = args;

    const processedDataArray = new Float32Array(
      processedData.buffer,
      processedData.byteOffset,
      processedData.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );

    const audioVector = await gaborator.synthesize(processedDataArray, analysisMetadata, sampleRate, params, normalize);

    parentPort!.postMessage({ result: audioVector });
  } catch (error) {
    parentPort!.postMessage({ error });
  }
});
