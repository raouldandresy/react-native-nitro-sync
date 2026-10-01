import { NitroModules } from 'react-native-nitro-modules';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  benchmarkNativeSyncQueue,
  type NitroSync,
  type SyncQueueBenchmarkResult,
} from 'react-native-nitro-sync';
import { Card, colors, Intro, ScreenShell } from '../components/ui';

const BATCH_SIZES = [10, 100, 1_000, 10_000] as const;
const RUNS = 3;

export default function BenchmarkScreen(): React.JSX.Element {
  const [results, setResults] = useState<readonly SyncQueueBenchmarkResult[]>([]);
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running');
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<void> => {
    setStatus('running');
    setError(null);
    try {
      const engine = NitroModules.createHybridObject<NitroSync>('NitroSync');
      engine.initialize('nitro-sync-benchmark.db');
      const rounds: SyncQueueBenchmarkResult[][] = [];
      for (let iteration = 0; iteration < RUNS; iteration += 1) {
        rounds.push([...(await benchmarkNativeSyncQueue(engine, BATCH_SIZES))]);
      }
      const medians = BATCH_SIZES.map((mutationCount, index) => {
        const samples = rounds.map((round) => round[index]);
        const median = (select: (sample: SyncQueueBenchmarkResult) => number): number => {
          const sorted = samples.map(select).sort((left, right) => left - right);
          return sorted[Math.floor(sorted.length / 2)] ?? 0;
        };
        const first = samples[0];
        if (first === undefined) {
          throw new Error(`Missing benchmark result for batch size ${mutationCount}`);
        }
        return {
          ...first,
          serializedPayloadBytes: median((sample) => sample.serializedPayloadBytes),
          claimResponseBytes: median((sample) => sample.claimResponseBytes),
          serializationMs: median((sample) => sample.serializationMs),
          deserializationMs: median((sample) => sample.deserializationMs),
          enqueueMs: median((sample) => sample.enqueueMs),
          enqueueMsPerMutation: median((sample) => sample.enqueueMsPerMutation),
          claimMs: median((sample) => sample.claimMs),
          jsBlockingMs: median((sample) => sample.jsBlockingMs),
        };
      });
      console.info('[NitroSyncBenchmark] median of 3 runs', JSON.stringify(medians));
      setResults(medians);
      setStatus('done');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setError(message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <ScreenShell>
      <Intro
        eyebrow={`Native queue · ${Platform.OS === 'android' ? 'Android' : 'iOS'}`}
        title="Benchmark"
        detail={`Dedicated SQLite database · ${RUNS} runs per batch · median shown. Synthetic ${BATCH_SIZES.join(', ')}-mutation batches with 256-byte bodies.`}
      />
      <Card title="Interpretazione">
        <Text style={styles.body}>
          Queste misure includono runtime e database del dispositivo o simulatore corrente. Non sono
          prestazioni rappresentative di un dispositivo fisico né una previsione della latenza
          end-to-end o del consumo di memoria.
        </Text>
      </Card>
      {status === 'running' && (
        <Card title="Benchmark in esecuzione">
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.body}>Il batch da 10.000 mutation può richiedere alcuni secondi.</Text>
        </Card>
      )}
      {error !== null && (
        <Card title="Benchmark non riuscito">
          <Text style={styles.error}>{error}</Text>
        </Card>
      )}
      {results.map((result) => (
        <Card key={result.mutationCount} title={`${result.mutationCount.toLocaleString()} mutation`}>
          <Metric label="Enqueue totale (JS → Nitro)" value={`${result.enqueueMs.toFixed(2)} ms`} />
          <Metric label="Enqueue per mutation" value={`${result.enqueueMsPerMutation.toFixed(4)} ms`} />
          <Metric label="Claim batch" value={`${result.claimMs.toFixed(2)} ms`} />
          <Metric label="JSON encode · JS" value={`${result.serializationMs.toFixed(2)} ms`} />
          <Metric label="JSON decode · JS" value={`${result.deserializationMs.toFixed(2)} ms`} />
          <Metric label="Ritardo event loop" value={`${result.jsBlockingMs.toFixed(2)} ms`} />
          <Metric label="Dimensione payload serializzato" value={`${result.serializedPayloadBytes.toLocaleString()} B`} />
          <Metric label="Dimensione risposta claim" value={`${result.claimResponseBytes.toLocaleString()} B`} />
        </Card>
      ))}
      <Pressable
        accessibilityRole="button"
        disabled={status === 'running'}
        onPress={() => { void run(); }}
        style={({ pressed }) => [styles.button, pressed && styles.pressed, status === 'running' && styles.disabled]}
      >
        <Text style={styles.buttonLabel}>{status === 'running' ? 'Benchmark in corso…' : 'Esegui di nuovo'}</Text>
      </Pressable>
    </ScreenShell>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <View style={styles.metric}>
      <Text style={styles.body}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.red, fontSize: 13 },
  metric: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  value: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  button: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: colors.primary },
  pressed: { opacity: 0.76 },
  disabled: { opacity: 0.5 },
  buttonLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
});
