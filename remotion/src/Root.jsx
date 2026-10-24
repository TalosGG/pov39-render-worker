import React from 'react';
import { Composition } from 'remotion';
import MotionComposition from './MotionComposition.jsx';
import { durationInFrames, resolveFormat } from './format.js';

/**
 * The only registered composition. Its duration, size and frame rate are derived
 * from the validated composition data passed in as input props, so one
 * composition covers every POV39 motion asset.
 */
export const RemotionRoot = () => (
  <Composition
    id="POV39Motion"
    component={MotionComposition}
    durationInFrames={450}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ composition: null }}
    calculateMetadata={({ props }) => {
      const format = resolveFormat(props?.composition);
      return {
        width: format.width,
        height: format.height,
        fps: format.fps,
        durationInFrames: durationInFrames(props?.composition),
      };
    }}
  />
);