# DSH Web — приватное развёртывание

Комплект для восстановления веб-доступа к DeepSeek Harness на Windows:

- Basic-авторизация перед DSH (шлюз на `127.0.0.1:3099`);
- автозапуск после входа в Windows (DSH + шлюз + portproxy);
- русский интерфейс (языковой пакет `dsh-locale-ru`);
- внешний HTTPS через reverse proxy (OpenResty/nginx) на `:3080`.

> **Никаких реальных паролей, API-ключей и токенов в репозитории нет.**
> `web-auth-proxy.auth.json`, `.credentials.yaml`, `web-auth-proxy.secret`
> и логи исключены через `.gitignore`. В примере используется
> `admin` / `change-me` — обязательно смените пароль после установки.

## Схема

```
Браузер
  -> https://<ваш-домен>        (TLS, OpenResty/nginx)
  -> http://<LAN-IP>:3080
  -> netsh portproxy 0.0.0.0:3080 -> 127.0.0.1:3099
  -> web-auth-proxy.cjs          (HTTP Basic, русские страницы ошибок)
  -> http://127.0.0.1:3081       (DSH Web)
```

DSH требует одноразовый launch-token, который печатается только при старте.
Шлюз не показывает его наружу: он подписывает DSH-cookie долговременным
секретом из `%USERPROFILE%\.dsh\.credentials.yaml`
(`client-connection/browser-session`). Поэтому перезапуск DSH не ломает вход,
а браузер видит только Basic-авторизацию шлюза.

## Состав репозитория

| Путь | Назначение |
|---|---|
| `deploy/web-auth-proxy.cjs` | Basic-шлюз: HTTP + WebSocket, подпись DSH-cookie |
| `deploy/web-auth-supervisor.ps1` | Супервизор: DSH, шлюз, portproxy |
| `deploy/set-password.ps1` | Смена логина/пароля (scrypt, без перезапуска) |
| `deploy/hash-password.cjs` | Хеширование пароля для `auth.json` |
| `deploy/install-task.ps1` | Задача планировщика при входе в Windows |
| `deploy/web-auth-proxy.auth.json.example` | Пример файла учётных данных |
| `locale/dsh-locale-ru/` | Готовый русский языковой пакет |
| `locale/tools/` | Исходники перевода и скрипты обновления |
| `docs/dsh-web-access.txt` | Краткая памятка администратора |

## Требования

- Windows 10/11, PowerShell 5.1+.
- Node.js 22+ (`node.exe` в `PATH`).
- Один раз запущенный DSH, чтобы создался профиль:
  ```powershell
  npx @deepseek-ai/dsh web --port 3081 --no-open
  ```
  Дождитесь строки `dsh web:` и остановите (`Ctrl+C`).
- Права администратора — для `netsh portproxy` и задачи планировщика.
- Внешний reverse proxy с TLS, который проксирует на `<LAN-IP>:3080`.

## Установка

### 1. Файлы шлюза

Скопируйте в `%USERPROFILE%\.dsh\`:

- `web-auth-proxy.cjs`
- `web-auth-supervisor.ps1`
- `set-password.ps1`
- `hash-password.cjs`

### 2. Русский язык

Скопируйте `locale\dsh-locale-ru` в
`%USERPROFILE%\.dsh\profiles\web\locale-ru` и создайте junction:

```powershell
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-locale-ru" `
  -Target "$env:USERPROFILE\.dsh\profiles\web\locale-ru"
```

В `profiles\web\package.json` добавьте зависимость:

```json
"dependencies": {
  "dsh-locale-ru": "file:locale-ru"
}
```

В `profiles\web\cordis.patch.yml` добавьте:

```yaml
- insert:
    - id: locale-ru
      name: dsh-locale-ru

- id: locale
  config:
    preference: ru
```

### 3. Пароль

```powershell
cd "$env:USERPROFILE\.dsh"
powershell -ExecutionPolicy Bypass -File .\set-password.ps1 -User admin
```

Скрипт спросит пароль (минимум 8 символов), запишет
`web-auth-proxy.auth.json` и проверит вход. Пароль в открытом виде нигде
не сохраняется — только scrypt-хеш.

> Не используйте `admin` / `root` на публичном домене. Минимум 12–16
> символов, уникальный пароль.

### 4. Portproxy и автозапуск

Из PowerShell **от администратора**:

```powershell
cd "$env:USERPROFILE\.dsh"
powershell -ExecutionPolicy Bypass -File .\install-task.ps1

netsh interface portproxy add v4tov4 `
  listenaddress=0.0.0.0 listenport=3080 `
  connectaddress=127.0.0.1 connectport=3099
```

`install-task.ps1` создаёт задачу **DSH Web Auth Gateway**:
- триггер — вход пользователя, задержка 10 секунд;
- повышенные права;
- без ограничения времени выполнения;
- перезапуск супервизора до 3 раз при сбое.

Супервизор каждые 10 секунд проверяет DSH (`:3081`) и шлюз (`:3099`),
каждые 60 секунд — portproxy; после аварии подхватывает устаревший lock.

### 5. Проверка

```powershell
# без пароля — 401
curl.exe -i http://127.0.0.1:3080/

# с паролем — 200
curl.exe -u admin:ВАШ_ПАРОЛЬ http://127.0.0.1:3080/

# снаружи
curl.exe -u admin:ВАШ_ПАРОЛЬ https://<ваш-домен>/
```

После перезагрузки Windows: войти в систему, подождать 15–40 секунд,
открыть сайт. Если сразу `502` — DSH ещё стартует, обновить страницу.

## Смена пароля

```powershell
cd "$env:USERPROFILE\.dsh"
powershell -ExecutionPolicy Bypass -File .\set-password.ps1 -User admin
```

- Шлюз перечитывает `web-auth-proxy.auth.json` в течение ~5 секунд.
- Перезапуск DSH/задачи не нужен.
- В браузере нажмите `Ctrl+F5`.
- Если меняли **логин**, закройте вкладку: браузер мог закешировать старые
  Basic-учётные данные. При необходимости очистите сохранённый вход для
  домена.

Сменить логин:

```powershell
powershell -ExecutionPolicy Bypass -File .\set-password.ps1 -User newadmin
```

## Автозапуск и диагностика

```powershell
Get-ScheduledTask -TaskName 'DSH Web Auth Gateway'
Get-ScheduledTaskInfo -TaskName 'DSH Web Auth Gateway'
Get-Content "$env:USERPROFILE\.dsh\web-stack-supervisor.log" -Tail 30
```

Логи:

| Файл | Что внутри |
|---|---|
| `~\.dsh\web-stack-supervisor.log` | запуск/падение DSH и шлюза, portproxy |
| `~\.dsh\web-auth-proxy.log` | авторизация, ошибки шлюза |
| `~\.dsh\web-live.log` | stdout DSH, включая launch-URL |
| `~\.dsh\web-live.err.log` | stderr DSH |

Частые проблемы:

- **502 сразу после перезагрузки** — DSH стартует 15–40 секунд, подождите.
- **401 после смены пароля** — браузер прислал старый Basic; `Ctrl+F5`,
  закройте/откройте вкладку.
- **Домен перестал работать после перезагрузки** — сменился LAN-IP.
  Закрепите его DHCP-reservation в роутере или задайте статический IP.
- **Порт 3080 занят** — проверьте `Get-NetTCPConnection -LocalPort 3080`;
  portproxy должен принадлежать `iphlpsvc`.

## Безопасность

- Снаружи только HTTPS; Basic-пароль шифруется на участке браузер → proxy.
- Basic-пароль и cookie шлюза — единственный внешний барьер. Кто их знает,
  получает полный доступ к агенту и машине.
- DSH слушает только `127.0.0.1:3081`; шлюз — только `127.0.0.1:3099`.
- Не открывайте `:3081` и `:3099` в сеть.
- Не коммитьте `web-auth-proxy.auth.json`, `.credentials.yaml`,
  `web-auth-proxy.secret`, логи и сессии.

## Обновление русского перевода

Инструменты лежат в `locale/tools/`:

```powershell
cd locale\tools
node _build-dicts2.cjs   # извлечь английские словари из установленного DSH
node _translate-ru.cjs   # доперевести новые строки (Google Translate)
node _gen-client.cjs     # собрать client.js языкового пакета
```

После генерации добавьте/измените комментарий в
`profiles\web\cordis.patch.yml`, чтобы HMR перечитал профиль, или
перезагрузите страницу. Подробности — в `locale/tools/README.md`.

## Лицензия

MIT. Сторонние компоненты DSH сохраняют свои лицензии.
