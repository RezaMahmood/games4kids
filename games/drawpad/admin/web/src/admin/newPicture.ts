import type { NewPicture } from '../api';
import { encodeBytes } from '../stencil/browser';
import { chosenPicture, type ChoosingPhase, type DescriptionItem, type PhotoItem, type ReadyPhase } from './uploadModel';

export async function buildNewPicture(item: PhotoItem, phase: ReadyPhase): Promise<NewPicture> {
  const { photo, generated } = phase;
  return {
    title: item.title.trim(),
    kinds: ['trace'],
    width: photo.width,
    height: photo.height,
    original: await encodeBytes(photo, 'image/jpeg'),
    outline: await encodeBytes(generated.outline, 'image/png'),
  };
}

/** A paint by number picture from the scene the admin picked, with that scene as its original. */
export async function buildPbnPicture(item: DescriptionItem, phase: ChoosingPhase): Promise<NewPicture> {
  const chosen = chosenPicture(phase);
  if (!chosen) throw new Error('Pick a picture first.');
  const { scene, pbn } = chosen;
  return {
    title: item.title.trim(),
    kinds: ['pbn'],
    width: scene.width,
    height: scene.height,
    original: await encodeBytes(scene, 'image/jpeg'),
    pbn: pbn.pbn,
    pbnRegions: await encodeBytes(pbn.regions, 'image/png'),
    pbnPreview: await encodeBytes(pbn.preview, 'image/png'),
  };
}
