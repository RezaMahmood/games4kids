import { useState } from 'preact/hooks';
import { Segmented } from '../../../play/web/src/components/Segmented';
import { AdminGallery } from './screens/AdminGallery';
import { AdminLimits } from './screens/AdminLimits';
import { AdminUpload } from './screens/AdminUpload';

type Section = 'upload' | 'gallery' | 'limits';

const SECTIONS = [
  { value: 'upload', label: 'Upload' },
  { value: 'gallery', label: 'Gallery' },
  { value: 'limits', label: 'Limits' },
] as const;

export function App() {
  const [section, setSection] = useState<Section>('upload');
  return (
    <div class="screen">
      <header class="top-bar sections">
        <div class="bar-side">
          <Segmented label="Draw Pad admin" value={section} options={SECTIONS} onChange={setSection} />
        </div>
      </header>
      <main class="admin-main">
        {section === 'upload' && <AdminUpload />}
        {section === 'gallery' && <AdminGallery />}
        {section === 'limits' && <AdminLimits />}
      </main>
    </div>
  );
}
