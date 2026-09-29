import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSyncCollection, type SyncRecord } from 'react-native-nitro-sync';
import { ActionButton, Badge, Card, colors, Intro, ScreenShell } from '../../components/ui';

interface Note extends SyncRecord {
  readonly text: string;
}

export default function NotesScreen(): React.JSX.Element {
  const notes = useSyncCollection<Note>('notes');
  const [draft, setDraft] = useState('');

  const addNote = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    notes.insert({ text });
    setDraft('');
  };

  return (
    <ScreenShell>
      <Intro
        eyebrow="Schermata 01 · CRUD locale"
        title="Le tue note"
        detail="Le modifiche vengono mostrate subito e salvate nella coda locale prima di essere inviate."
      />
      <Card title="Nuova nota" detail="Prova anche in modalità aereo: la scrittura resta locale.">
        <TextInput
          accessibilityLabel="Testo della nuova nota"
          onChangeText={setDraft}
          onSubmitEditing={addNote}
          placeholder="Scrivi un promemoria..."
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          style={styles.input}
          value={draft}
        />
        <ActionButton label="Salva nota sul dispositivo" onPress={addNote} />
      </Card>
      <Card title={`Archivio · ${notes.data.length}`}>
        {notes.data.length === 0 ? (
          <Text style={styles.empty}>Nessuna nota ancora. Aggiungine una per iniziare.</Text>
        ) : notes.data.map((note) => (
          <View key={note.id} style={styles.item}>
            <View style={styles.itemContent}>
              <Text style={styles.noteText}>{note.text}</Text>
              <Text numberOfLines={1} style={styles.id}>ID {note.id}</Text>
            </View>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Modifica ${note.text}`}
                onPress={() => notes.update(note.id, { text: `${note.text} · modificata` })}
                style={styles.iconButton}
              >
                <Text style={styles.actionText}>Modifica</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Elimina ${note.text}`}
                onPress={() => notes.delete(note.id)}
                style={[styles.iconButton, styles.deleteButton]}
              >
                <Text style={[styles.actionText, styles.deleteText]}>Elimina</Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Badge label={`Sync: ${notes.status}`} tone={notes.status === 'error' ? 'red' : 'blue'} />
        {notes.error !== null && <Text style={styles.error}>{notes.error.message}</Text>}
      </Card>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.ink, backgroundColor: colors.surface },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  item: { gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  itemContent: { gap: 4 },
  noteText: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  id: { color: colors.muted, fontSize: 11 },
  actions: { flexDirection: 'row', gap: 8 },
  iconButton: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.paleBlue },
  deleteButton: { backgroundColor: colors.paleRed },
  actionText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  deleteText: { color: colors.red },
  error: { color: colors.red, fontSize: 13 },
});
