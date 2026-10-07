# 비투스의 키워드 세상 🌏

블로그·콘텐츠 주제 발굴용 키워드 대시보드. GitHub Actions가 매일 00·06·12·18시(KST)에 키워드를 모아 `data/`에 커밋하면 Vercel이 정적 사이트로 배포한다.

## 데이터 소스

| 소스 | 키 | 내용 |
|---|---|---|
| 구글 급상승 검색어 (RSS) | 불필요 | 한국 급상승 검색어, 검색량 구간, 관련 뉴스 |
| 네이버 쇼핑인사이트 | 불필요 | 10개 분야별 인기 검색어 TOP 20 (어제 하루 기준) |
| 구글·유튜브·네이버 자동완성 | 불필요 | 키워드별 연관 검색어 (글감 아이디어) |
| 유튜브 인기 동영상 | `YOUTUBE_API_KEY` | 한국 인기 동영상 50개, 태그 빈도 |
| 네이버 데이터랩 | `NAVER_HUB_KEY_ID`, `NAVER_HUB_KEY` (NAVER API HUB) | 최근 30일 검색 추이 |
| 네이버 검색광고 키워드도구 | `NAVER_AD_API_KEY`, `NAVER_AD_SECRET`, `NAVER_AD_CUSTOMER_ID` | 월간 검색량(PC·모바일) |

키는 GitHub 저장소 **Settings → Secrets and variables → Actions**에 넣으면 다음 수집부터 자동으로 켜진다.

## API 키 발급

- **유튜브**: [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 생성 → "YouTube Data API v3" 사용 설정 → 사용자 인증 정보 → API 키
- **네이버 데이터랩**: 2026-07-31부터 개발자센터 신규 발급이 끝나고 [네이버 클라우드 플랫폼](https://www.ncloud.com/)의 NAVER API HUB에서 발급한다. 콘솔에서 NAVER API HUB 이용 신청 → API 키(ID·Key) 발급. 예전 개발자센터 키(`NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`)도 2027-06-30까지는 동작한다.
- **네이버 검색광고**: [searchad.naver.com](https://searchad.naver.com/) 가입(무료) → 도구 → API 사용 관리 → 액세스 라이선스·비밀키·CUSTOMER_ID

## 메뉴

- **통합**: 플랫폼마다 1위 100점, 순위가 내려갈수록 감점. 네이버 쇼핑은 70%만 반영. 한 플랫폼 안에서는 최고 점수 하나만 세고, 여러 플랫폼에 동시에 뜨면 플랫폼 하나당 +50점.
- **구글 / 네이버(급상승·쇼핑) / 유튜브(키워드·영상)**: 플랫폼별 목록. 모든 페이지에서 같은 분야(연예·방송, 스포츠, 패션·뷰티 등)로 거를 수 있다.
- **분야 분류**: 네이버 쇼핑 분야 → 키워드·관련 뉴스 제목의 단어 규칙 → 유튜브 영상 분야 → 기타 순서로 정한다 (`scripts/collect.mjs`의 `RULES`).

## 로컬 실행

```bash
node scripts/collect.mjs
python3 -m http.server 8000
```
