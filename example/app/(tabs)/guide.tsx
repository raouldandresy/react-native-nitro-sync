import { StyleSheet, Text, View } from 'react-native';
import { Badge, Card, colors, Intro, ScreenShell } from '../../components/ui';

const steps = [
  ['01', 'Scrittura locale', 'insert, update e delete aggiornano subito la collection e registrano una mutation persistente.'],
  ['02', 'Invio per tabella', 'Il provider raggruppa le mutation per tabella e passa al transport cursor, device ID e lastSyncedAt.'],
  ['03', 'Risposta server', 'Il backend dovrebbe deduplicare gli ID, restituire gli ACK e le modifiche successive al cursor.'],
  ['04', 'Merge e settlement', 'I record remoti vengono uniti ai dati locali; ACK rimuovono le mutation, errori restano riprovabili.'],
] as const;

export default function GuideScreen(): React.JSX.Element {
  return (
    <ScreenShell>
      <Intro
        eyebrow="Schermata 04 · guida rapida"
        title="Come funziona"
        detail="La libreria gestisce il client e la persistenza locale. L'app host resta responsabile del backend e delle credenziali."
      />
      <Card title="Il ciclo di sync">
        {steps.map(([number, title, detail]) => (
          <View key={number} style={styles.step}>
            <Badge label={number} />
            <View style={styles.stepCopy}>
              <Text style={styles.stepTitle}>{title}</Text>
              <Text style={styles.body}>{detail}</Text>
            </View>
          </View>
        ))}
      </Card>
      <Card title="Cosa dimostra questa app">
        <Text style={styles.body}>• CRUD ottimistico in due collection locali: notes e tasks.</Text>
        <Text style={styles.body}>• Transport di esempio con deduplicazione, cursor, tombstone e fallimento simulato.</Text>
        <Text style={styles.body}>• Queue SQLite nativa Nitro (se disponibile), adapter OP-SQLite e metadata MMKV.</Text>
        <Text style={styles.body}>• Strategia di merge configurata nel provider per i record JSON.</Text>
      </Card>
      <Card title="Cosa non dimostra">
        <Text style={styles.body}>• Il server mock non è persistente, autenticato o adatto alla produzione.</Text>
        <Text style={styles.body}>• Un test su un singolo device non verifica la convergenza tra più utenti/dispositivi.</Text>
        <Text style={styles.body}>• Il background mobile è best-effort e non garantisce l'esecuzione.</Text>
        <Text style={styles.body}>Per integrare un backend, implementa il protocollo documentato nel README del package e usa un endpoint HTTPS autenticato.</Text>
      </Card>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  stepCopy: { flex: 1, gap: 4 },
  stepTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});
