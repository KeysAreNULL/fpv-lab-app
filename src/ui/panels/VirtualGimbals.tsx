import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';

/**
 * On-screen gimbals.
 *
 * Positioned by the pilot, not by the layout: drag an empty stick to move its
 * home position, then it stays where their thumb falls. That matters on a
 * phone, where a fixed layout is either unreachable in landscape or in the way
 * of the other thumb.
 *
 * The pointer handling lives here rather than in the driver so the DOM
 * elements can claim and track events, while the driver keeps the state.
 */
export function VirtualGimbals(): JSX.Element | null {
  const input = useStore((s) => s.input);
  const cameraMode = useStore((s) => s.cameraMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const rafRef = useRef(0);

  // Place the sticks once the layout is known.
  useEffect(() => {
    if (!input || positioned.current) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    input.touch.setStickHome('left', rect.width * 0.22, rect.height * 0.66);
    input.touch.setStickHome('right', rect.width * 0.78, rect.height * 0.66);
    positioned.current = true;
  }, [input]);

  // Reposition on a meaningful layout change, e.g. a rotation.
  useEffect(() => {
    const handle = (): void => {
      const container = containerRef.current;
      if (!container || !input) return;
      const rect = container.getBoundingClientRect();
      input.touch.setStickHome('left', rect.width * 0.22, rect.height * 0.66);
      input.touch.setStickHome('right', rect.width * 0.78, rect.height * 0.66);
    };
    window.addEventListener('resize', handle);
    window.addEventListener('orientationchange', handle);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('orientationchange', handle);
    };
  }, [input]);

  // Drive the DOM from the driver's state so there is one source of truth.
  useEffect(() => {
    if (!input) return undefined;
    const tick = (): void => {
      const left = input.touch.stickVisual('left');
      const right = input.touch.stickVisual('right');
      if (leftRef.current) {
        leftRef.current.style.left = `${left.cx}px`;
        leftRef.current.style.top = `${left.cy}px`;
        const knob = leftRef.current.firstElementChild as HTMLElement | null;
        if (knob) knob.style.transform = `translate(${left.kx}px, ${left.ky}px)`;
      }
      if (rightRef.current) {
        rightRef.current.style.left = `${right.cx}px`;
        rightRef.current.style.top = `${right.cy}px`;
        const knob = rightRef.current.firstElementChild as HTMLElement | null;
        if (knob) knob.style.transform = `translate(${right.kx}px, ${right.ky}px)`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [input]);

  const onPointerDown = useCallback(
    (side: 'left' | 'right') => (event: React.PointerEvent<HTMLDivElement>) => {
      if (!input) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      event.currentTarget.setPointerCapture(event.pointerId);
      input.touch.pointerDown(event.pointerId, side, event.clientX - rect.left, event.clientY - rect.top);
    },
    [input],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!input) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      input.touch.pointerMove(event.pointerId, event.clientX - rect.left, event.clientY - rect.top);
    },
    [input],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      input?.touch.pointerUp(event.pointerId);
    },
    [input],
  );

  if (!input || cameraMode !== 'fpv') return null;

  return (
    <div className="gimbals" ref={containerRef}>
      <div
        className="gimbal"
        ref={leftRef}
        onPointerDown={onPointerDown('left')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ left: '22%', top: '66%' }}
      >
        <div className="gimbal-knob" />
        <div className="gimbal-label">Yaw / Throttle</div>
      </div>
      <div
        className="gimbal"
        ref={rightRef}
        onPointerDown={onPointerDown('right')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ left: '78%', top: '66%' }}
      >
        <div className="gimbal-knob" />
        <div className="gimbal-label">Roll / Pitch</div>
      </div>

      <div className="touch-buttons">
        <ArmButton />
        <button
          className="touch-btn"
          onPointerDown={() => input.touch.setButton('angle', true)}
          onPointerUp={() => input.touch.setButton('angle', false)}
          onPointerLeave={() => input.touch.setButton('angle', false)}
        >
          ANG
        </button>
        <button
          className="touch-btn"
          onPointerDown={() => input.touch.setButton('acro', true)}
          onPointerUp={() => input.touch.setButton('acro', false)}
          onPointerLeave={() => input.touch.setButton('acro', false)}
        >
          ACRO
        </button>
      </div>
    </div>
  );
}

function ArmButton(): JSX.Element {
  const input = useStore((s) => s.input);
  const phase = useStore((s) => s.snapshot?.phase);
  const [on, setOn] = useState(false);

  const release = (): void => {
    input?.touch.setButton('arm', false);
    setOn(false);
  };

  return (
    <button
      className="touch-btn arm"
      data-on={phase === 'flying' || phase === 'armed' || on}
      onPointerDown={() => {
        input?.touch.setButton('arm', true);
        setOn(true);
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      ARM
    </button>
  );
}
