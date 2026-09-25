// example/app/index.tsx
import { Pressable, ScrollView, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { useSyncCollection } from 'react-native-nitro-sync';

type Note = {
  readonly id: string;
  readonly text: string;
};

export default function HomeScreen(): React.JSX.Element {
  // Nota: usiamo 'posts' per mappare l'endpoint mock di JSONPlaceholder
  const notes = useSyncCollection<Note>('posts');

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Live API Sync</Text>
      <Text style={styles.sectionTitle}>Record Locali (SQLite): {notes.data.length}</Text>

      <ScrollView style={styles.records}>
        {notes.data.map((note) => (
          <View key={note.id} style={styles.record}>
            <Text style={styles.recordText}>
              #{note.id} - {note.text}
            </Text>
            <View style={styles.row}>
              <Pressable
                onPress={() => notes.update(note.id, { text: `${note.text} (modificato)` })}
                style={styles.smallButton}
              >
                <Text style={styles.buttonText}>Modifica</Text>
              </Pressable>
              <Pressable onPress={() => notes.delete(note.id)} style={styles.smallButton}>
                <Text style={styles.buttonText}>Elimina</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    <View style={styles.row}>
      <Pressable
        onPress={() =>
          notes.insert({
            text: `Nuova nota offline ${new Date().toLocaleTimeString()}`,
          })
        }
        style={styles.button}
      >
        <Text style={styles.buttonText}>Aggiungi Nota (Scrittura Istantanea)</Text>
      </Pressable>

      <Pressable onPress={() => void notes.refresh()} style={styles.secondaryButton}>
        {notes.status === 'syncing' ? (
          <ActivityIndicator color="#16324F" />
        ) : (
          <Text style={styles.secondaryButtonText}>Sincronizza Ora con il Server</Text>
        )}
      </Pressable>
    </View>
      <View style={styles.statusBox}>
        <Text style={styles.statusText}>Stato Sync: {notes.status.toUpperCase()}</Text>
        {notes.error !== null && <Text style={styles.error}>Errore API: {notes.error.message}</Text>}
        <Text style={styles.statusText}>
          Ultima Sincronizzazione: {notes.lastSyncedAt === null ? 'Mai' : new Date(notes.lastSyncedAt).toLocaleTimeString()}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 12, padding: 24, paddingTop: 20, backgroundColor: '#F8FAFC' },
  title: { fontSize: 26, fontWeight: '700', color: '#0F172A' },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#475569' },
  records: { maxHeight: '70%' },
  record: { borderColor: '#CBD5E1', borderWidth: 1, borderRadius: 8, gap: 8, padding: 12, marginBottom: 8, backgroundColor: '#FFFFFF' },
  recordText: { fontSize: 15, color: '#1E293B' },
  row: { flexDirection: 'row', gap: 8 },
  button: { flex:1,backgroundColor: '#16324F', padding: 14, borderRadius: 8 },
  smallButton: { backgroundColor: '#285A7A', flex: 1, padding: 8, borderRadius: 6 },
  secondaryButton: { flex:1,borderColor: '#16324F', borderWidth: 1, padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', textAlign: 'center', fontWeight: '600' },
  secondaryButtonText: { color: '#16324F', textAlign: 'center', fontWeight: '600' },
  statusBox: { marginTop: 12, padding: 12, backgroundColor: '#E2E8F0', borderRadius: 8, gap: 4 },
  statusText: { fontSize: 13, color: '#334155' },
  error: { color: '#B42318', fontWeight: '600' },
});