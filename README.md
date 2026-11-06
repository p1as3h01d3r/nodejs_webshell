# Node.js webshell — лабораторный стенд

`POST /shell` выполняет команду через `/bin/sh` внутри контейнера и возвращает результат в JSON. Внешних npm-зависимостей нет.

> **Только для изолированной лаборатории.** Это намеренное выполнение произвольных команд без авторизации. Не открывай порт в интернет или общую сеть, не подключай каталоги хоста, секреты и Docker socket. Контейнер не заменяет отдельную виртуальную машину для недоверенного кода.

## Запуск в Docker

Нужны Docker Engine / Docker Desktop и Docker Compose v2.

```sh
docker compose up --build -d
```

API доступен только с хоста: `http://127.0.0.1:3000`.

```sh
curl -sS http://127.0.0.1:3000/shell \
  -H 'Content-Type: application/json' \
  -d '{"command":"id; printf hello"}'
```

Пример ответа (UID/GID могут отличаться):

```json
{
  "stdout": "uid=1000(node) gid=1000(node) groups=1000(node)\nhello",
  "stderr": "",
  "exitCode": 0,
  "signal": null,
  "error": null
}
```

- Поле запроса: `command`, непустая строка. Поддерживаются пайпы, перенаправления и несколько команд. Используется `/bin/sh`, не Bash.
- Ненулевой код завершения команды тоже возвращается с HTTP 200 — смотри `exitCode` и `stderr`.
- Лимиты: 5 секунд на выполнение, 1 MiB суммарного вывода, 16 KiB на тело запроса. При превышении времени или вывода группа процессов получает `SIGKILL`, а `error` содержит `TIMEOUT` или `OUTPUT_LIMIT`. Ошибка запуска — `SPAWN_ERROR`.
- Ошибки запроса: HTTP 400 — неверный JSON/`command`, 413 — слишком большое тело, 415 — неверный `Content-Type`. Для `/shell` разрешён только POST (иначе 405), неизвестный путь даёт 404.
- Проверка состояния: `GET /health` → `{"status":"ok"}`.

Контейнер запускается от пользователя `node`, без capabilities и повышения привилегий. Compose ограничивает память до 128 MiB, CPU до 0.5, процессы до 64. Файловая система доступна только для чтения, кроме временного `/tmp` размером 64 MiB. Рабочий каталог команд — `/app`; для записи используй `/tmp`. Файлы в `/tmp` исчезают при остановке контейнера. Между запросами не сохраняются `cd` и переменные shell.

Логи и остановка:

```sh
docker compose logs -f
docker compose down
```

## Деплой в Kubernetes

Используй отдельный лабораторный кластер, не production: namespace и NetworkPolicy не заменяют изоляцию недоверенного кода.

Манифесты находятся в `k8s/`: отдельный namespace `webshell-lab`, Deployment с одной репликой, Service типа `ClusterIP` и NetworkPolicy. Ingress, NodePort и LoadBalancer намеренно не создаются.

### Образ и registry

Собери и отправь образ в registry, доступный узлам кластера. **Замени `registry.example.com/lab/webshell` на свой адрес**:

```sh
docker build -t registry.example.com/lab/webshell:1.0.0 .
docker push registry.example.com/lab/webshell:1.0.0
```

В `k8s/kustomization.yaml` укажи тот же адрес в `images[].newName` и тег в `newTag`. Для каждого обновления используй новый тег либо digest, а не перезаписывай старый образ. Если registry приватный, настрой `imagePullSecrets` в `spec.template.spec` Deployment; соответствующий Secret должен существовать в namespace `webshell-lab`.

Для локального kind/minikube вместо push можно загрузить образ через `kind load docker-image` / `minikube image load`, указав в Kustomization имя и тег загруженного образа.

### Применение и проверка

Проверь выбранный kubectl context, затем примени манифесты:

```sh
kubectl config current-context
kubectl apply -k k8s/
kubectl -n webshell-lab rollout status deployment/webshell --timeout=120s
kubectl -n webshell-lab get pods,svc
```

Для доступа с хоста запусти в отдельном терминале:

```sh
kubectl -n webshell-lab port-forward --address=127.0.0.1 service/webshell 3000:3000
```

После этого работают те же запросы к `http://127.0.0.1:3000/shell` и `/health`, что и для Compose. Порт 3000 на хосте должен быть свободен.

Из Pod в том же namespace адрес сервиса — `http://webshell:3000`. NetworkPolicy разрешает вход только от Pod с меткой `webshell-client: "true"` **в namespace `webshell-lab`**. Для Pod в других namespace доступ по умолчанию закрыт. Это сетевой фильтр, не авторизация API.

Исходящий трафик webshell Pod полностью запрещён, включая DNS, Kubernetes API и интернет. **NetworkPolicy действует только при поддержке со стороны CNI** — обязательно проверь это в своём кластере. Другие разрешающие политики могут расширить доступ.

### Настройки контейнера

- UID/GID 1000, `runAsNonRoot`, `seccompProfile: RuntimeDefault`, запрет повышения привилегий, удалены все capabilities.
- ServiceAccount token не монтируется; нет hostPath, секретов, host network и Docker socket.
- Корневая файловая система только для чтения, `/tmp` — `emptyDir` в памяти до 64 MiB. Его содержимое сохраняется при перезапуске контейнера внутри того же Pod, но не при замене Pod.
- Запрос ресурсов: 100m CPU / 64 MiB; лимит: 500m CPU / 128 MiB. Содержимое `/tmp` тоже расходует лимит памяти.
- Startup, readiness и liveness probes проверяют `/health`. Kubernetes не использует Docker `HEALTHCHECK`.
- В образ добавлен `tini` для обработки дочерних процессов. При `SIGTERM`/`SIGINT` Node.js перестаёт принимать соединения и даёт активным запросам до 10 секунд; `terminationGracePeriodSeconds` — 15 секунд.
- Compose-параметр `pids_limit` не переносится в обычный Pod-манифест: лимит PID должен настроить администратор узлов через kubelet `podPidsLimit`.

Логи:

```sh
kubectl -n webshell-lab logs deployment/webshell
```

## Запуск без Docker и тесты

Нужны Node.js 22+ и Linux/другая POSIX-система. Установка пакетов не требуется.

```sh
npm test
HOST=127.0.0.1 npm start
```

По умолчанию сервер слушает `0.0.0.0:3000`; для локального доступа используй `HOST=127.0.0.1`, как в примере выше. Адрес и порт задаются переменными `HOST` и `PORT`. **Без Docker команды выполняются напрямую на хосте** с правами пользователя сервера, без контейнерных ограничений.
