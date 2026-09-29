import type { PropsWithChildren, ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export const colors = {
  background: '#F4F7FB',
  surface: '#FFFFFF',
  ink: '#102238',
  muted: '#63758A',
  primary: '#1664D9',
  border: '#DCE5EF',
  green: '#147D55',
  red: '#B42318',
  paleBlue: '#EAF2FF',
  paleGreen: '#E8F6EF',
  paleRed: '#FDECEB',
};

export function ScreenShell({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Intro({ eyebrow, title, detail }: {
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
}): React.JSX.Element {
  return (
    <View style={styles.intro}>
      <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.detail}>{detail}</Text>
    </View>
  );
}

export function Card({ title, detail, children }: PropsWithChildren<{
  readonly title: string;
  readonly detail?: string;
}>): React.JSX.Element {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        {detail === undefined ? null : <Text style={styles.detail}>{detail}</Text>}
      </View>
      {children}
    </View>
  );
}

export function ActionButton({ label, onPress, secondary = false, disabled = false }: {
  readonly label: string;
  readonly onPress: () => void;
  readonly secondary?: boolean;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabledButton,
        pressed && !disabled && styles.pressedButton,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, tone = 'blue' }: {
  readonly label: string;
  readonly tone?: 'blue' | 'green' | 'red' | 'gray';
}): React.JSX.Element {
  const toneStyle = {
    blue: styles.badgeBlue,
    green: styles.badgeGreen,
    red: styles.badgeRed,
    gray: styles.badgeGray,
  }[tone];
  return (
    <View style={[styles.badge, toneStyle]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

export function InfoRow({ label, value, trailing }: {
  readonly label: string;
  readonly value: string;
  readonly trailing?: ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      {trailing ?? <Text style={styles.infoValue}>{value}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, gap: 16, padding: 20, paddingBottom: 32, backgroundColor: colors.background },
  intro: { gap: 6, paddingTop: 8, paddingBottom: 4 },
  eyebrow: { color: colors.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '800' },
  detail: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  card: { gap: 14, padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: colors.surface },
  cardHeader: { gap: 4 },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  button: { minHeight: 46, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, borderRadius: 10, backgroundColor: colors.primary },
  secondaryButton: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  disabledButton: { opacity: 0.5 },
  pressedButton: { opacity: 0.76 },
  buttonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  secondaryButtonText: { color: colors.ink },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  badgeBlue: { backgroundColor: colors.paleBlue },
  badgeGreen: { backgroundColor: colors.paleGreen },
  badgeRed: { backgroundColor: colors.paleRed },
  badgeGray: { backgroundColor: '#EDF1F5' },
  badgeText: { color: colors.ink, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  infoRow: { minHeight: 32, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  infoLabel: { color: colors.muted, fontSize: 13 },
  infoValue: { color: colors.ink, fontSize: 13, fontWeight: '600', textAlign: 'right', flexShrink: 1 },
});
