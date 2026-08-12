async function renderNormalized(file: File): Promise<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = 900; canvas.height = 1125;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) { bitmap.close(); throw new Error('This browser could not prepare the mystery preview.'); }
  context.fillStyle = '#fff3d3'; context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const width = bitmap.width * scale; const height = bitmap.height * scale;
  const x = (canvas.width - width) / 2; const y = (canvas.height - height) / 2;
  context.drawImage(bitmap, x, y, width, height); bitmap.close();
  return { canvas, context };
}

function canvasFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(new File([blob], name, { type: 'image/png' })) : reject(new Error('Could not prepare the image.')), 'image/png'));
}

export async function normalizeUpload(file: File): Promise<File> {
  const { canvas } = await renderNormalized(file);
  return canvasFile(canvas, `${file.name.replace(/\.[^.]+$/, '')}-normalized.png`);
}

export async function createSilhouette(file: File): Promise<File> {
  const { canvas, context } = await renderNormalized(file);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const samples: number[] = [];
  for (let offset = 0; offset < image.data.length; offset += 64) {
    if ((image.data[offset + 3] ?? 0) < 20) continue;
    samples.push((image.data[offset] ?? 0) * .2126 + (image.data[offset + 1] ?? 0) * .7152 + (image.data[offset + 2] ?? 0) * .0722);
  }
  samples.sort((a, b) => a - b);
  const percentile = samples[Math.floor(samples.length * .58)] ?? 150;
  const threshold = Math.max(72, Math.min(240, percentile));
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3] ?? 0;
    const luminance = (image.data[offset] ?? 0) * .2126 + (image.data[offset + 1] ?? 0) * .7152 + (image.data[offset + 2] ?? 0) * .0722;
    const pixel = offset / 4;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);
    const distance = Math.hypot((x - canvas.width / 2) / (canvas.width / 2), (y - canvas.height / 2) / (canvas.height / 2));
    const edgeSeparation = Math.min(92, distance * 76);
    const dark = alpha > 20 && luminance + edgeSeparation <= threshold;
    image.data[offset] = dark ? 5 : 82; image.data[offset + 1] = dark ? 15 : 224; image.data[offset + 2] = dark ? 26 : 223; image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvasFile(canvas, `${file.name.replace(/\.[^.]+$/, '')}-silhouette.png`);
}
