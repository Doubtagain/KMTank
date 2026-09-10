# KMTank 배포 가이드 (Cloudflare Pages + Render + Supabase)

목표: **월 0원.** 세 서비스 모두 카드 등록 없이 무료 플랜으로 끝납니다.

```
Cloudflare Pages ──HTTPS/WSS──▶ Render ──▶ Supabase Postgres
   (클라이언트)                  (게임 서버)    (계정 · MMR)
```

전체 소요 시간은 20~30분입니다. 아래 순서를 지키면 값을 두 번 넣는 일이 없습니다.

| 순서 | 할 일 | 얻는 것 |
| --- | --- | --- |
| 1 | Supabase 프로젝트 생성 | `DATABASE_URL` |
| 2 | Render에 서버 배포 | 서버 주소 `https://kmtank-server.onrender.com` |
| 3 | Cloudflare Pages에 클라이언트 배포 | 클라이언트 주소 `https://kmtank.pages.dev` |
| 4 | Render에 클라이언트 주소 등록 | CORS 완성 |
| 5 | (선택) Google OAuth → 랭크 모드 활성화 | `GOOGLE_CLIENT_ID` |

준비물: GitHub 계정(리포지토리 `Doubtagain/KMTank`가 이미 푸시되어 있음), Google 계정.

---

## 1. Supabase — 데이터베이스

무료 플랜: Postgres 500 MB, 1주일간 요청이 없으면 일시정지(대시보드에서 클릭 한 번으로 재개).

1. <https://supabase.com/dashboard> 로그인 → **New project**.
2. 입력:
   - **Name**: `kmtank`
   - **Database Password**: **Generate a password**를 누르고 **반드시 어딘가에 복사**해 두세요. 이 값이 연결 문자열에 들어갑니다.
   - **Region**: `Northeast Asia (Seoul)` 또는 `Northeast Asia (Tokyo)`
   - **Pricing plan**: Free
3. **Create new project** → 1~2분 기다립니다.
4. 프로젝트 화면 **상단의 `Connect` 버튼** 클릭 (또는 좌측 하단 ⚙ **Project Settings → Database**).
5. **Connection string** 탭에서 **Method(또는 Type)를 `Session pooler`로** 선택합니다.

   > **왜 Session pooler인가:** Render 무료 인스턴스는 IPv4로만 나갑니다. `db.xxxx.supabase.co:5432`로 시작하는 "Direct connection"은 IPv6 전용이라 Render에서 **연결이 안 됩니다.** 호스트가 `aws-0-…pooler.supabase.com`이고 포트가 `5432`인 것을 고르세요. (`Transaction pooler`, 포트 6543도 동작은 하지만 필요 없습니다.)

6. 표시된 URI를 복사하고 `[YOUR-PASSWORD]` 부분을 2번에서 저장한 비밀번호로 바꿉니다. 완성형:

   ```
   postgresql://postgres.abcdefghijklmnop:비밀번호@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres
   ```

   비밀번호에 `@`, `#`, `%` 같은 특수문자가 있으면 URL 인코딩이 필요합니다(`@`→`%40`, `#`→`%23`). 애매하면 비밀번호를 영숫자로만 재설정하세요(Project Settings → Database → Reset database password).

7. 이 문자열을 메모장에 `DATABASE_URL`로 적어 둡니다. **마이그레이션은 안 해도 됩니다.** 서버가 부팅할 때 `schema.sql`을 직접 적용하며, 여러 번 실행해도 안전하게 작성되어 있습니다.

---

## 2. Render — 게임 서버

무료 플랜: 512 MB, 월 750시간(서비스 하나를 상시 켜두기에 충분). **약 15분간 접속이 없으면 잠들고, 다음 접속자가 30~60초 콜드 스타트를 겪습니다.** 그 외에는 전부 동작합니다.

1. <https://dashboard.render.com> 로그인 (GitHub으로 가입하면 다음 단계가 쉽습니다).
2. 우측 상단 **New +** → **Blueprint**.
3. **Connect GitHub** → `Doubtagain/KMTank` 선택 (처음이면 GitHub에서 Render 앱에 이 리포지토리 접근 권한을 허용).
4. Render가 리포지토리 루트의 `render.yaml`을 읽어 `kmtank-server` 서비스를 제안합니다. **Blueprint Name**은 아무거나(`kmtank`).
5. 아래 환경변수를 물어봅니다. 채워 넣으세요:

   | 변수 | 값 |
   | --- | --- |
   | `DATABASE_URL` | 1단계에서 만든 문자열 |
   | `CORS_ORIGINS` | 일단 `https://kmtank.pages.dev` (3단계에서 다른 이름을 쓰면 4단계에서 수정) |
   | `GOOGLE_CLIENT_ID` | 비워 두기 (5단계에서 채움) |

   `JWT_SECRET`은 Render가 자동 생성합니다. 건드리지 마세요 — 바꾸면 전원 로그아웃됩니다.

6. **Apply** → 첫 빌드는 Docker 이미지라 3~5분 걸립니다.
7. 완료되면 서비스 페이지 상단에 주소가 뜹니다: `https://kmtank-server.onrender.com` (이름이 겹치면 뒤에 무작위 문자가 붙습니다 — **실제 표시된 주소를 그대로 메모**).
8. 확인:

   ```
   https://kmtank-server.onrender.com/health      → {"ok":true,"service":"kmtank","season":1}
   https://kmtank-server.onrender.com/api/config  → "durableRanks":true 여야 함
   ```

   `durableRanks`가 `false`면 DB 연결에 실패해 인메모리로 폴백한 것입니다. Render 서비스의 **Logs** 탭에서 `[db]`로 시작하는 줄을 보세요. 거의 항상 비밀번호 오타 아니면 Direct connection 문자열을 쓴 경우입니다.

**리전:** `render.yaml`의 `region: singapore`는 Render 리전 중 한국에서 가장 가깝습니다(오리건·오하이오·버지니아·프랑크푸르트·싱가포르 중). 실시간 게임이라 이 선택이 체감에 가장 큽니다.

---

## 3. Cloudflare Pages — 클라이언트

무료 플랜: 대역폭 무제한, 월 500회 빌드. 작은 번들을 많은 사람에게 뿌리는 용도에 딱 맞습니다.

1. <https://dash.cloudflare.com> 로그인 → 좌측 **Workers & Pages** (또는 **Compute (Workers)** → **Workers & Pages**).
2. **Create** → **Pages** 탭 → **Import an existing Git repository** → **Connect GitHub** → `Doubtagain/KMTank` 선택 → **Begin setup**.
3. 빌드 설정:

   | 항목 | 값 |
   | --- | --- |
   | **Project name** | `kmtank` → 주소가 `https://kmtank.pages.dev`가 됩니다. 이미 누가 쓰고 있으면 다른 이름으로 하고 4단계에서 `CORS_ORIGINS`를 그에 맞춰 고치세요. |
   | **Production branch** | `main` |
   | **Framework preset** | `None` |
   | **Build command** | `npm run build -w @kmtank/shared && npm run build -w @kmtank/client` |
   | **Build output directory** | `packages/client/dist` |
   | **Root directory** | 비워 두기 |

4. 같은 화면 아래 **Environment variables (advanced)** 펼치기 → **Add variable** 두 개:

   | 변수 | 값 |
   | --- | --- |
   | `VITE_SERVER_URL` | 2단계 서버 주소. 예: `https://kmtank-server.onrender.com` — **끝에 `/` 붙이지 않기** |
   | `NODE_VERSION` | `22` |

   > `VITE_SERVER_URL`은 빌드 시점에 번들 안에 박힙니다. 나중에 바꾸면 **Deployments → 최근 배포 → Retry deployment**로 다시 빌드해야 반영됩니다.

5. **Save and Deploy** → 1~2분.
6. `https://kmtank.pages.dev` 를 열면 메뉴가 뜨고 **Play Casual**이 바로 됩니다. (서버가 잠들어 있었다면 첫 접속에 30~60초 걸릴 수 있습니다.)

   메뉴 상단에 "This server has no database configured…" 경고가 보이면 2단계의 `durableRanks`를 다시 확인하세요.

---

## 4. Render에 클라이언트 주소 등록 (CORS)

3단계에서 프로젝트 이름을 `kmtank`로 했고 2단계에서 `CORS_ORIGINS`를 `https://kmtank.pages.dev`로 넣었다면 **이 단계는 이미 끝난 것**입니다. 다른 이름을 썼다면:

1. Render → `kmtank-server` → 좌측 **Environment**.
2. `CORS_ORIGINS`를 실제 Pages 주소로 수정. 여러 개면 쉼표로 구분, **끝에 `/` 없이**:
   ```
   https://kmtank.pages.dev,https://kmtank.example.com
   ```
3. **Save Changes** → Render가 자동 재배포합니다.

값은 `스킴 + 호스트 + 포트`가 **완전히 일치**해야 합니다. `https://kmtank.pages.dev`와 `https://kmtank.pages.dev/`는 다른 문자열입니다.

---

## 5. Google OAuth — 랭크 모드 (선택)

이 단계를 건너뛰면 캐주얼만 동작하고, 메뉴에 "Ranked is unavailable" 안내가 표시됩니다. 언제든 나중에 해도 됩니다.

1. <https://console.cloud.google.com/apis/credentials> → 상단에서 프로젝트 선택 또는 **새 프로젝트** (`KMTank`).
2. 처음이면 **OAuth 동의 화면(OAuth consent screen)** 구성을 먼저 요구합니다:
   - User Type: **External** → 앱 이름 `KMTank`, 지원 이메일, 개발자 연락처 입력 → 저장.
   - 범위(Scopes)는 추가할 필요 없습니다(기본 `email`, `profile`, `openid`만 사용).
   - 테스트 모드 상태로 두면 **테스트 사용자로 등록한 계정만** 로그인됩니다. 누구나 로그인하게 하려면 **앱 게시(Publish app)**를 누르세요 — 기본 범위만 쓰므로 별도 검토 없이 즉시 게시됩니다.
3. **사용자 인증 정보 만들기(Create credentials)** → **OAuth 클라이언트 ID** → 애플리케이션 유형 **웹 애플리케이션**.
4. **승인된 JavaScript 원본(Authorised JavaScript origins)**에 클라이언트가 뜨는 주소를 **전부** 추가:
   - `https://kmtank.pages.dev`
   - `http://localhost:5173` (로컬 개발용)
   - 커스텀 도메인이 있으면 그것도

   **승인된 리디렉션 URI는 비워 둡니다.** KMTank는 Google Identity Services 방식이라 리디렉션이 없습니다.
5. **만들기** → 표시되는 **클라이언트 ID**(`…apps.googleusercontent.com`)를 복사. **클라이언트 보안 비밀번호(secret)는 쓰지 않습니다** — 어디에도 넣지 마세요.
6. Render → `kmtank-server` → **Environment** → `GOOGLE_CLIENT_ID`에 붙여넣기 → **Save Changes** (자동 재배포, 1~2분).
7. `https://kmtank.pages.dev` 새로고침 → "Sign in with Google" 버튼이 보이고, 로그인하면 이름과 `Placements 0/5`가 뜨면 완료. **Play Ranked**가 활성화됩니다.

로그인이 실패하면 브라우저 콘솔(F12)을 보세요:
- `The given origin is not allowed…` → 4번 원본 목록에 현재 주소가 없음.
- 서버가 401 `Google rejected the credential` → Render의 `GOOGLE_CLIENT_ID`가 콘솔에서 만든 것과 **다른 값**임.

---

## 완료 확인 체크리스트

```
https://kmtank-server.onrender.com/health       {"ok":true,...}
https://kmtank-server.onrender.com/api/config   "googleEnabled":true, "durableRanks":true
https://kmtank-server.onrender.com/api/stats    {"rooms":1,"players":0,"queued":0}
https://kmtank.pages.dev                        메뉴 → Play Casual 정상, 경고 문구 없음
```

랭크는 **동시에 4명**이 큐에 들어와야 매치가 시작됩니다(`RANKED_MIN_PLAYERS`). 친구 3명과 같이 테스트하거나, 혼자서라면 브라우저 탭 4개에 서로 다른 Google 계정으로 로그인하면 됩니다. 4명이 모이면 최대 30초(`RANKED_QUEUE_GRACE`) 뒤에 시작하고, 매치는 8분(`RANKED_MATCH_SECONDS`)입니다. 둘 다 Render Environment에서 조절할 수 있습니다.

---

## 이후 운영

- **재배포**: `main`에 푸시하면 Render와 Pages 둘 다 자동으로 다시 빌드됩니다.
- **시즌 리셋**: Render의 `SEASON`을 `2`로 올리면 새 래더가 시작됩니다. 이전 시즌 데이터는 DB에 남습니다.
- **콜드 스타트가 싫다면**: 무료 크론 서비스(cron-job.org 등)로 `/health`를 10분마다 호출하면 Render 인스턴스가 잠들지 않습니다. 월 750시간 한도 안에서 상시 가동은 가능하지만, 이 방식이 Render 무료 플랜의 취지에 맞는지는 Render 약관을 직접 확인하세요.
- **Supabase 일시정지**: 1주일간 DB 요청이 없으면 프로젝트가 멈춥니다. 대시보드에서 **Restore**를 누르면 몇 분 안에 돌아오고, 데이터는 보존됩니다. 플레이어가 꾸준히 있으면 발생하지 않습니다.
- **비용 상한**: 세 서비스 모두 사용량 초과 시 **과금이 아니라 거부**(빌드 실패, 연결 거절)로 동작합니다. 갑자기 요금이 나올 구조가 아닙니다.
- **로그**: 서버 오류는 Render → Logs, 빌드 오류는 Pages → Deployments → 해당 배포 → Build log.
