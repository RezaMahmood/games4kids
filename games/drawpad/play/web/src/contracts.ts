import type { DrawingMeta, Picture } from '../../../data/types';

export type CanvasScreenProps = {
  picture: Picture;
  drawing: DrawingMeta;
  onLeave: () => void;
  startFinish?: boolean;
};
