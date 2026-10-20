import type { DrawingMeta, Picture } from '../../../../data/types';
import { galleryImage, pictureFile } from '../api';
import { BlobImage } from '../../../../play/web/src/blobs/BlobImage';

type Props = { drawing: DrawingMeta & { userId: string }; picture: Picture | undefined };

/** A read-only view of a saved drawing: the pen layer over the picture's outline. Paint by numbers only shows progress. */
export function DrawingArt({ drawing, picture }: Props) {
  if (drawing.kind === 'pbn') {
    const painted = drawing.filledRegions?.length ?? 0;
    return (
      <div class="art placeholder">
        <strong>{painted}</strong>
        <span>{painted === 1 ? 'region painted' : 'regions painted'}</span>
      </div>
    );
  }
  return (
    <div class="art" style={picture ? { aspectRatio: `${picture.width} / ${picture.height}` } : undefined}>
      {picture && <BlobImage path={pictureFile(picture.id, 'outline.png')} />}
      <BlobImage path={galleryImage(drawing.userId, drawing.id)} revalidate />
    </div>
  );
}
