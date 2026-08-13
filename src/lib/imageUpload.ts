async function renderNormalized(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  // The required 1280×720 shared display renders the portrait at roughly
  // 320–400 CSS pixels. Matching that surface avoids paying live-event
  // decrypt/decode costs for pixels the presentation cannot show.
  canvas.width = 400; canvas.height = 500;
  const context = canvas.getContext('2d');
  if (!context) { bitmap.close(); throw new Error('This browser could not prepare the image.'); }
  context.fillStyle = '#fff3d3'; context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const width = bitmap.width * scale; const height = bitmap.height * scale;
  context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  bitmap.close();
  return canvas;
}

function canvasFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(new File([blob], name, { type: 'image/png' })) : reject(new Error('Could not prepare the image.')), 'image/png'));
}

export async function normalizeUpload(file: File): Promise<File> {
  return canvasFile(await renderNormalized(file), `${file.name.replace(/\.[^.]+$/, '')}-normalized.png`);
}
