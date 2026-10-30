// Exact upstream fixtures plus test-only preparation/observation. Product
// executables receive neither a clock override nor a TLS-root override.
import {createHash} from 'node:crypto'
const need=(ok)=>{if(!ok)throw Error('formal_receipt_retry_fixture_changed')}
const common=`
func retryObserveConsumer(t *testing.T, config, state, delivery string, expectedDue time.Time) transferclient.ReceiptBinding {
 t.Helper()
 var binding transferclient.ReceiptBinding
 for i := 0; i < 2; i++ {
  cmd := exec.CommandContext(t.Context(), os.Getenv("ENDPOINT_CONSUMER_NODE"), os.Getenv("ENDPOINT_RETRY_CONSUMER"), os.Getenv("ENDPOINT_RECEIPT_EXE"), config, state, delivery)
  raw, err := cmd.CombinedOutput()
  if err != nil { t.Fatalf("paired consumer: %v %s", err, raw) }
  var out map[string]json.RawMessage
  var stateValue string
  if json.Unmarshal(raw, &out) != nil || json.Unmarshal(out["state"], &stateValue) != nil || stateValue != "waiting" || string(out["advances"]) != "0" { t.Fatalf("early advance: %s", raw) }
  var due string
  if json.Unmarshal(out["next_due_at"], &due) != nil { t.Fatal("missing consumer deadline") }
  parsed, err := time.Parse(time.RFC3339Nano, due)
  if err != nil || !parsed.Equal(expectedDue) { t.Fatalf("consumer shortened original deadline: %s", raw) }
  if json.Unmarshal(out["receipt"], &binding) != nil { t.Fatal("missing original receipt") }
 }
 return binding
}
`
export const retryFixtures={
 'retry-transfer':{file:'receipt_binding_positive_test.go',sha256:'cc98c3684c507062006bc05f5603ad8c4601d7a8318909dab28a57389bebef53',test:'TestCLIPathRetryTransferPair'},
 'retry-association':{file:'cli_path_test.go',sha256:'e91ee5070387f59a37c3b81b2db80a426bec62ef7b4f9e13fc7030fc1ee68729',test:'TestCLIPathRetryAssociationPair'},
}
export function retryPairOverlay(raw,mode){
 const fixture=retryFixtures[mode];need(fixture&&Buffer.isBuffer(raw))
 const source=raw.toString('utf8'),canonical=source.replaceAll('\r\n','\n')
 need(raw.equals(Buffer.from(source))&&(source===canonical||source===canonical.replaceAll('\n','\r\n')))
 need(createHash('sha256').update(canonical).digest('hex')===fixture.sha256)
 let text=canonical
 const replace=(before,after)=>{need(text.split(before).length===2);text=text.replace(before,()=>after)}
 if(mode==='retry-transfer'){
  replace('func TestCLIPathReceiptBindingPositiveChildReadOnly(t *testing.T) {','func '+fixture.test+'(t *testing.T) {')
  replace('cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestReceiptBindingCommandChild$") //nolint:gosec // This exact test executable, fixed helper only.',
   'cmd := exec.CommandContext(ctx, os.Getenv("ENDPOINT_RECEIPT_EXE"), "-action", "receipt-binding", "-delivery", closed.DeliveryID()) //nolint:gosec // Verified EXE and original fixture identity.')
  replace('w.WriteHeader(http.StatusInternalServerError)','w.Header().Set("Retry-After", "3600")\n\t\t\tw.WriteHeader(http.StatusServiceUnavailable)')
  replace('// Fixture preparation above reads bytes/credential and makes TLS requests.',`
 at := time.Now()
 for i := 0; i < 15; i++ {
  if prepared.Job.NextAttempt.After(at) { at = prepared.Job.NextAttempt.Add(time.Millisecond) }
  prepared, err = transferclient.InvokeConfiguredHerdr(t.Context(), env, "native-profile-v1", limits, action, server.Client(), at)
  if err != nil || prepared.Job.Phase != "uploading" || prepared.Job.Attempts != i+1 { t.Fatalf("recoverable retry: %+v %v", prepared, err) }
 }
 if prepared.Job.NextAttempt.Before(time.Now().Add(59*time.Minute)) { t.Fatal("Retry-After shortened") }
 beforeConsumer := requests.Load()
 observed := retryObserveConsumer(t, config, state, closed.DeliveryID(), prepared.Job.NextAttempt)
 if requests.Load() != beforeConsumer || observed.KnownReceipt != "original-receipt" || observed.Task != closed.Task || observed.Associated { t.Fatal("consumer changed original retry/receipt") }
 t.Log("retry_pair attempts=15 native_receipt=true fresh_consumer_processes=2 early_network=0 original_identity=true")
 // Fixture preparation above reads bytes/credential and makes TLS requests.`)
 }else{
  replace('func TestCLIPathTLSRestartAndLostResponses(t *testing.T) {','func '+fixture.test+'(t *testing.T) {')
  replace('resolves++','resolves++\n\t\t\tif resolves <= 15 { w.Header().Set("Retry-After", "3600"); w.WriteHeader(http.StatusServiceUnavailable); return }')
  replace('// Fresh processes reopen the original journal after each dropped response.\n\tfor range 2 {',
    '// Fresh processes reopen the original journal after each dropped response.\n\tfor range 17 {')
  replace('done := invoke("advance-results", "", nil)',`
 mu.Lock(); beforeConsumer := resolves; mu.Unlock()
 observed := retryObserveConsumer(t, config, state, closed.DeliveryID(), now.Add(-time.Millisecond))
 mu.Lock(); unchanged := resolves == beforeConsumer && commits == 1; mu.Unlock()
 if observed.KnownReceipt != "receipt-one" || observed.Task != closed.Task || observed.Associated || observed.AssociationState != "unknown" || !unchanged { t.Fatal("unknown result replayed or consumer changed original state") }
 done := invoke("advance-results", "", nil)`)
  replace('resolves != 1 || !bytes.Equal(uploaded, data)','resolves != 16 || !bytes.Equal(uploaded, data)')
  replace('t.Fatal("source changed")\n\t}\n}',
   't.Fatal("source changed")\n\t}\n\tt.Log("retry_pair unknown_failures=15 commit=1 resolve=16 native_receipt=true fresh_consumer_processes=2 early_network=0")\n}')
 }
 text+='\n'+common
 return source===canonical?text:text.replaceAll('\n','\r\n')
}
