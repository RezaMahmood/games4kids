import { useReducer, useState } from 'preact/hooks';
import type { Picture, PictureKind } from '../../../data/types';
import { api, ApiFailure } from './api';
import { Dialog } from './components/Dialog';
import { PlayerBar } from './components/PlayerBar';
import { initialState, journeysOpen, reduce, type PlayerView } from './session/state';
import { useUsageTimer } from './usage/useUsageTimer';
import { Freestyle } from './screens/Freestyle';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { PaintByNumbers } from './screens/PaintByNumbers';
import { Picker } from './screens/Picker';

type CanvasView = Extract<PlayerView, { kind: 'canvas' }>;

export function App({ name }: { name: string }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useUsageTimer(true, state.time.kind === 'up', (usage) => dispatch({ type: 'usage', usage }));

  const start = async (picture: Picture, kind: PictureKind, returnTo: 'picker' | 'history') => {
    setStarting(true);
    setNotice(null);
    try {
      dispatch({ type: 'openCanvas', picture, drawing: await api.createDrawing(picture.id, kind), returnTo });
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'time_up') dispatch({ type: 'timeUp' });
      else setNotice('Couldn’t start that drawing. Try again.');
    } finally {
      setStarting(false);
    }
  };

  const view = state.view;
  const timeUpDialog = state.time.kind === 'up' && state.time.dialog && (
    <Dialog
      title="That’s all for today!"
      onClose={() => dispatch({ type: 'dismissTimeUp' })}
      actions={<button type="button" class="primary" onClick={() => dispatch({ type: 'dismissTimeUp' })}>OK</button>}
    >
      <p>You’ve used all your drawing time. Your drawings are saved in History. See you tomorrow!</p>
    </Dialog>
  );
  const canvasProps = (v: CanvasView) => ({
    picture: v.picture,
    drawing: v.drawing,
    startFinish: v.startFinish,
    onLeave: () => dispatch({ type: 'leaveCanvas' }),
  });
  const open = journeysOpen(state);
  return (
    <div class="screen">
      <PlayerBar
        canGoBack={view.kind !== 'home'}
        historyActive={view.kind === 'history'}
        minutesLeft={state.time.kind === 'open' ? state.time.minutesLeft : null}
        onBack={() => dispatch({ type: view.kind === 'canvas' ? 'leaveCanvas' : 'goHome' })}
        onHistory={() => dispatch({ type: 'openHistory' })}
      />
      {view.kind === 'canvas' && (
        view.drawing.kind === 'pbn'
          ? <PaintByNumbers key={view.drawing.id} {...canvasProps(view)} />
          : <Freestyle key={view.drawing.id} {...canvasProps(view)} />
      )}
      {view.kind === 'home' && <Home name={name} timeUp={!open} onStart={(mode) => dispatch({ type: 'openPicker', mode })} />}
      {view.kind === 'picker' && (
        <Picker
          mode={view.mode}
          busy={starting}
          onMode={(mode) => dispatch({ type: 'openPicker', mode })}
          onPick={(picture) => start(picture, view.mode, 'picker')}
        />
      )}
      {view.kind === 'history' && (
        <History
          timeUp={!open}
          busy={starting}
          onEdit={(picture, drawing, startFinish) => dispatch({ type: 'openCanvas', picture, drawing, returnTo: 'history', startFinish })}
          onAgain={(picture, kind) => start(picture, kind, 'history')}
        />
      )}
      {notice && <div class="toast alert" role="alert" onClick={() => setNotice(null)}>{notice}</div>}
      {timeUpDialog}
    </div>
  );
}
