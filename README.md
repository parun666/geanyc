# Geany C Web IDE

A Geany-like browser IDE for C with hidden uploaded source playback. Uploaded `.c`
files are stored in browser memory and are not shown until the editor trigger is
typed.

## Run

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`.

The backend listens on `http://localhost:3001`, and Vite proxies `/api` calls to it.

## Hidden Typing Flow

1. Click the toolbar arrow beside the new-file icon.
2. Upload a `.c` file. The file is saved on the backend in `server/hidden-files`.
3. On the first editor line, type a trigger like:

```c
// hello.c
```

4. Once the uploaded filename matches, every printable key press is intercepted.
   The real key is blocked, and the next character from the hidden file is
   inserted at the current cursor position.
5. Use the reset button in the toolbar to disarm hidden typing.

Every browser connected to the same backend sees the hidden filename list. The
source text is still not previewed; it is fetched only when the first-line
trigger matches and then appears through simulated typing.

To use it from another device on the same network, start the app with:

```powershell
npm run dev
```

Then open:

```text
http://YOUR-COMPUTER-LAN-IP:5173
```

For example, if the host computer is `192.168.1.20`, open
`http://192.168.1.20:5173` on the other device.

## Compile And Run

The API supports:

- `POST /api/compile` for build only
- `POST /api/compile-run` for build and execution

Request body:

```json
{
  "code": "int main(void) { return 0; }"
}
```

Local mode requires `gcc` on PATH.

```powershell
npm run server
```

Docker sandbox mode uses the `gcc:latest` image, disables networking, applies a
memory limit, and uses command timeouts:

```powershell
$env:USE_DOCKER = "1"
npm run server
```

Execution also has a backend timeout to stop long-running programs.
