/**
 * Esegue `POST /api/git/commit` in un PROCESSO A PARTE.
 *
 * Perché non basta chiamare la route dentro il test: `Bun.spawn` senza `env`
 * passa al figlio l'ambiente FOTOGRAFATO all'avvio del processo, non
 * `process.env` di adesso (lo documenta `lib/git-identity.ts`). Un test che
 * ripulisce `process.env` e poi chiama la route in-process NON tocca il git che
 * la route lancia: quello continua a vedere il `~/.gitconfig` di chi esegue i
 * test, il commit riesce comunque e il banco passa anche col fix rimosso —
 * misurato il 16/08, prima versione di `files.git-commit-identity.test.ts`.
 *
 * L'unico modo onesto di mettersi nella condizione del runner è che l'ambiente
 * pulito sia quello con cui il processo NASCE. Da qui questo harness: il
 * chiamante lancia `bun` con l'env che vuole, e ciò che git vede è esattamente
 * quello.
 *
 * Uso: bun <questo file> <repoDir> <messaggio>   → stampa JSON su stdout.
 */
import { createFilesRouter } from "./files";

const [repo, message] = process.argv.slice(2);
if (!repo || !message) {
  console.log(JSON.stringify({ harnessError: "uso: <repoDir> <messaggio>" }));
  process.exit(2);
}

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  errorResponse: (status: number, msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => (p === repo ? repo : null),
} as any);

const req = new Request("http://x/api/git/commit", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: repo, message }),
});

const res = await router(req, new URL(req.url), "/api/git/commit", "POST");
const body = res ? await res.json() : { harnessError: "route non ha risposto" };
console.log(JSON.stringify({ status: res?.status ?? 0, body }));
