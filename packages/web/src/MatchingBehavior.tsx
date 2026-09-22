import type { MatchingSettings } from '@vvv/shared';
import { sizePolicyLabel } from './matching-controls';

function ValueBadge({ current, fallback }: { current: number | null; fallback: number | null }) {
  return <span className="matching-badge">{current === fallback ? 'Default' : 'Current'}</span>;
}

function duration(ms: number) {
  if (ms % 60000 === 0) {
    const minutes = ms / 60000;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export function MatchingBehavior({ matching }: { matching: MatchingSettings }) {
  return (
    <section className="matching-card" aria-labelledby="matching-heading">
      <h2 id="matching-heading">Matching behavior</h2>
      <p>
        Exact matching is always on. Enable or disable perceptual methods in Advanced matching
        controls.
      </p>
      <dl className="matching-methods">
        {matching.methods.map((method) => (
          <div className="matching-method" key={method.id}>
            <dt>
              <strong>{method.label}</strong>
              <span className="metadata">
                {method.scope}
                {method.id === 'exact' ? ' · Always on' : ''}
              </span>
              <span className="matching-badge">{method.enabled ? 'Enabled' : 'Off'}</span>
            </dt>
            <dd>
              <p>
                {method.id === 'exact'
                  ? 'Identical content hashes; no similarity threshold'
                  : method.id === 'audio_chromaprint'
                    ? 'Raw Chromaprint subfingerprints; finds clips inside longer recordings'
                    : `${method.id === 'video_dhash' ? 'Mean aligned-frame Hamming distance' : 'Hamming distance'} ≤ ${method.threshold}`}{' '}
                {method.id !== 'audio_chromaprint' && (
                  <ValueBadge
                    current={method.threshold}
                    fallback={method.id === 'exact' ? null : method.id === 'image_dhash' ? 6 : 10}
                  />
                )}
              </p>
              {method.id === 'video_dhash' && (
                <>
                  <p>
                    {matching.video_frame_count}{' '}
                    {matching.video_frame_count === 1 ? 'frame' : 'frames'} per video{' '}
                    <ValueBadge current={matching.video_frame_count} fallback={9} />
                  </p>
                  <p>
                    Sampling timeout: {duration(matching.video_timeout_ms)}{' '}
                    <ValueBadge current={matching.video_timeout_ms} fallback={600000} />
                  </p>
                </>
              )}
              {method.id === 'audio_chromaprint' && (
                <p>
                  Fingerprinting timeout: {duration(matching.audio_timeout_ms)}{' '}
                  <ValueBadge current={matching.audio_timeout_ms} fallback={600000} />
                </p>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p>Size filter: {sizePolicyLabel(matching)}. Applies to the next scan.</p>
      <p className="matching-notice">
        Thresholds apply at match time, on the next match run. Existing groups reflect the last
        completed match run. Frame count and sampling timeout apply when videos are sampled; the
        fingerprinting timeout applies when audio is decoded.
      </p>
      <p>
        No AI or neural methods are used. Matching runs entirely locally: content hashes, perceptual
        dHash comparisons, and Chromaprint audio fingerprints.
      </p>
      <details>
        <summary>How matching works</summary>
        <p>
          Hamming distance counts the differing bits between two perceptual hashes. Lower thresholds
          are stricter. Videos compare frames at aligned sample positions and use the mean distance
          across those frames.
        </p>
        <p>
          The sampling timeout limits each ffprobe/ffmpeg operation, not the length of the video;
          decoding can still take time. Default means the documented default; Current means a
          different effective value. Changing matching values is a separate advanced capability, not
          available in this read-only section.
        </p>
      </details>
    </section>
  );
}
