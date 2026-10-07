# 비투스의 키워드 세상 🌏

블로그·콘텐츠 주제 발굴용 키워드 대시보드. GitHub Actions가 3시간마다 키워드를 모아 `data/`에 커밋하면 Vercel이 정적 사이트로 배포한다.

## 데이터 소스

| 소스 | 키 | 내용 |
|---|---|---|
| 구글 급상승 검색어 (RSS) | 불필요 | 한국 급상승 검색어, 검색량 구간, 관련 뉴스 |
| 네이버 쇼핑인사이트 | 불필요 | 10개 분야별 인기 검색어 TOP 20 (어제 하루 기준) |
| 구글·유튜브·네이버 자동완성 | 불필요 | 키워드별 연관 검색어 (글감 아이디어) |
| 유튜브 인기 동영상 | `YOUTUBE_API_KEY` | 한국 인기 동영상 50개, 태그 빈도 |
| 네이버 데이터랩 | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | 최근 30일 검색 추이 |
| 네이버 검색광고 키워드도구 | `NAVER_AD_API_KEY`, `NAVER_AD_SECRET`, `NAVER_AD_CUSTOMER_ID` | 월간 검색량(PC·모바일) |

키는 GitHub 저장소 **Settings → Secrets and variables → Actions**에 넣으면 다음 수집부터 자동으로 켜진다.

## API 키 발급

- **유튜브**: [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 생성 → "YouTube Data API v3" 사용 설정 → 사용자 인증 정보 → API 키
- **네이버 데이터랩**: [네이버 개발자센터](https://developers.naver.com/apps/#/register) → 애플리케이션 등록 → 사용 API "데이터랩(검색어트렌드)" → Client ID/Secret
- **네이버 검색광고**: [searchad.naver.com](https://searchad.naver.com/) 가입(무료) → 도구 → API 사용 관리 → 액세스 라이선스·비밀키·CUSTOMER_ID

## 관심 키워드

`config/seeds.json`의 `seeds`에 키워드를 넣으면 매일 연관 검색어를 모은다.

## 로컬 실행

```bash
node scripts/collect.mjs
python3 -m http.server 8000
```
