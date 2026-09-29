import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSyncCollection, type SyncRecord } from 'react-native-nitro-sync';
import { ActionButton, Badge, Card, colors, Intro, ScreenShell } from '../../components/ui';

interface Task extends SyncRecord {
  readonly title: string;
  readonly done: boolean;
}

export default function TasksScreen(): React.JSX.Element {
  const tasks = useSyncCollection<Task>('tasks');
  const [title, setTitle] = useState('');

  const addTask = (): void => {
    const value = title.trim();
    if (value.length === 0) return;
    tasks.insert({ title: value, done: false });
    setTitle('');
  };

  return (
    <ScreenShell>
      <Intro
        eyebrow="Schermata 02 · seconda collection"
        title="Attività"
        detail="Una tabella separata mostra come lo stesso provider gestisce più collection sincronizzate."
      />
      <Card title="Aggiungi attività">
        <TextInput
          accessibilityLabel="Titolo dell'attività"
          onChangeText={setTitle}
          onSubmitEditing={addTask}
          placeholder="Es. Preparare il rilascio"
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          style={styles.input}
          value={title}
        />
        <ActionButton label="Crea attività" onPress={addTask} />
      </Card>
      <Card title={`Da fare · ${tasks.data.filter((task) => !task.done).length}`}>
        {tasks.data.length === 0 ? (
          <Text style={styles.empty}>Crea un'attività per provarne gli aggiornamenti.</Text>
        ) : tasks.data.map((task) => (
          <View key={task.id} style={styles.item}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: task.done }}
              onPress={() => tasks.update(task.id, { done: !task.done })}
              style={[styles.checkbox, task.done && styles.checked]}
            >
              <Text style={[styles.taskTitle, task.done && styles.completed]}>{task.title}</Text>
              <Badge label={task.done ? 'Completata' : 'Aperta'} tone={task.done ? 'green' : 'gray'} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Elimina attività ${task.title}`}
              onPress={() => tasks.delete(task.id)}
              style={styles.delete}
            >
              <Text style={styles.deleteText}>Elimina</Text>
            </Pressable>
          </View>
        ))}
      </Card>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.ink, backgroundColor: colors.surface },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  item: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  checkbox: { flex: 1, gap: 8 },
  checked: { opacity: 0.7 },
  taskTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  completed: { textDecorationLine: 'line-through', color: colors.muted },
  delete: { padding: 8 },
  deleteText: { color: colors.red, fontSize: 12, fontWeight: '700' },
});
