import { Tabs } from 'expo-router';
import { colors } from '../../components/ui';

export default function TabLayout(): React.JSX.Element {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerTitleStyle: { color: colors.ink, fontWeight: '700' },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Notes', tabBarLabel: 'Notes' }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks', tabBarLabel: 'Tasks' }} />
      <Tabs.Screen name="sync" options={{ title: 'Sync', tabBarLabel: 'Sync' }} />
      <Tabs.Screen name="guide" options={{ title: 'Guide', tabBarLabel: 'Guide' }} />
    </Tabs>
  );
}
