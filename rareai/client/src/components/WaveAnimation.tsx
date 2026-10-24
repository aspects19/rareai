/**
 * Animated sound-wave / equaliser bars shown while the model is responding.
 * Immediately visible the moment the user sends — no blank bubble.
 */
export default function WaveAnimation() {
  const bars = [3, 5, 8, 5, 9, 6, 4, 7, 5, 3];
  return (
    <span
      aria-label="RareAI is responding…"
      className="inline-flex items-end gap-[3px] h-6 px-1"
    >
      {bars.map((height, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-gradient-to-t from-teal-500 to-indigo-400 opacity-90"
          style={{
            height: `${height * 2}px`,
            animation: `waveBar 1s ease-in-out ${(i * 0.09).toFixed(2)}s infinite alternate`,
          }}
        />
      ))}
    </span>
  );
}
