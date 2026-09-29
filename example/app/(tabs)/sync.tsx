import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSyncCollection } from 'react-native-nitro-sync';
import { ActionButton, Badge, Card, colors, InfoRow, Intro, ScreenShell } from '../../components/ui';
import { failNextSync, getMockServerSnapshot } from '../../testTransport';

export default function SyncScreen(): React.JSX.Element {
  const notes = useSyncCollection<{ id: string; text: string }>('notes');
  const tasks = useSyncCollection<{ id: string; title: string; done: boolean }>('tasks');
  const usingMockServer = !process.env.EXPO_PUBLIC_NITRO_SYNC_ENDPOINT;
  const [server, setServer] = useState(getMockServerSnapshot());

  const syncNotes = async (): Promise<void> => {
    await notes.refresh();
    setServer(getMockServerSnapshot());
  };

  const syncTasks = async (): Promise<void> => {
    await tasks.refresh();
    setServer(getMockServerSnapshot());
  };

  const runFailureDemo = async (): Promise<void> => {
    failNextSync();
    await notes.refresh();
    setServer(getMockServerSnapshot());
  };

  const lastSynced = (timestamp: number | null): string => (
    timestamp === null ? 'Mai' : new Date(timestamp).toLocaleTimeString()
  );

  return (
    <ScreenShell>
      <Intro
        eyebrow="Schermata 03 · trasporto"
        title="Stato sincronizzazione"
        detail="Il pulsante manuale invia la collection selezionata. Il transport predefinito è un mock in memoria."
      />
      {usingMockServer ? (
        <Card title="Collegamento mock" detail="Server fittizio: i suoi dati si azzerano quando il processo dell'app si chiude.">
          <View style={styles.serverState}>
            <Badge label="Mock in memoria" tone="gray" />
            <InfoRow label="Revisioni server" value={String(server.version)} />
            <InfoRow label="Record sul server" value={String(server.recordCount)} />
            <InfoRow label="Mutation viste" value={String(server.processedMutationCount)} />
          </View>
        </Card>
      ) : (
        <Card title="Transport HTTP">
          <Badge label="Endpoint configurato" tone="green" />
          <Text style={styles.endpoint}>{process.env.EXPO_PUBLIC_NITRO_SYNC_ENDPOINT}</Text>
        </Card>
      )}
      <Card title="Note">
        <InfoRow label="Stato" value={notes.status} trailing={<Badge label={notes.status} tone={notes.status === 'error' ? 'red' : 'blue'} />} />
        <InfoRow label="Ultima sync riuscita" value={lastSynced(notes.lastSyncedAt)} />
        {notes.error !== null && <Text style={styles.error}>{notes.error.message}</Text>}
        <ActionButton disabled={notes.status === 'syncing'} label={notes.status === 'syncing' ? 'Sincronizzazione in corso…' : 'Sincronizza note'} onPress={() => { void syncNotes(); }} />
      </Card>
      <Card title="Attività">
        <InfoRow label="Stato" value={tasks.status} trailing={<Badge label={tasks.status} tone={tasks.status === 'error' ? 'red' : 'blue'} />} />
        <InfoRow label="Ultima sync riuscita" value={lastSynced(tasks.lastSyncedAt)} />
        {tasks.error !== null && <Text style={styles.error}>{tasks.error.message}</Text>}
        <ActionButton disabled={tasks.status === 'syncing'} label="Sincronizza attività" onPress={() => { void syncTasks(); }} />
      </Card>
      {usingMockServer && (
        <Card title="Prova un errore di rete" detail="La prossima chiamata Notes fallirà apposta. I dati locali restano disponibili; premi poi di nuovo Sincronizza note per riprovare.">
          <ActionButton label="Simula un errore" onPress={() => { void runFailureDemo(); }} secondary />
        </Card>
      )}
      <Card title="Coda nativa Nitro" detail="Benchmark sintetico su un database SQLite dedicato. I risultati del simulatore non sono risultati di device fisico.">
        <Link asChild href="../benchmark">
          <Pressable style={styles.benchmarkLink}>
            <Text style={styles.benchmarkLinkText}>Apri benchmark della queue →</Text>
          </Pressable>
        </Link>
      </Card>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  serverState: { gap: 5, padding: 12, borderRadius: 12, backgroundColor: colors.background },
  error: { color: colors.red, fontSize: 13, lineHeight: 18 },
  endpoint: { color: colors.muted, fontSize: 12 },
  benchmarkLink: { minHeight: 44, justifyContent: 'center' },
  benchmarkLinkText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
});
