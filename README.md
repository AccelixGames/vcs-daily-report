# vcs-daily-report

PlasticSCM 워크스페이스의 일일 체크인을 자동 요약해서 Discord 로 발송하는 도구.

## 무엇

매일 09:00 KST 에 GitHub Actions cron 이 발동해 전날 09:00부터 당일 09:00 직전까지의 전체 체크인을 PlasticSCM Cloud 에서 조회한 뒤, 브랜치 `owner` attribute 기준 담당자별로 집계하고 Anthropic Claude 로 도메인별 요약을 만들어 Discord 채널에 보낸다. 개발자가 본인 컴퓨터를 켜둘 필요 없이 클라우드끼리만 통신해서 동작한다.

## 동작 흐름

```
GitHub Actions (ubuntu-latest, cron 0 0 * * *)
   │
   ├─ cm CLI 설치 (plasticscm-client-core)
   ├─ ~/.plastic4 에 client.conf / cloudregions.conf / unityorgs.conf 복원
   ├─ cm profile create — SSO 토큰으로 인증
   │
   ├─ cm find changeset
   │     · 전날 KST 09:00 ~ 당일 KST 09:00 직전
   │     · 전체 owner 체크인
   │     · 결과를 임시 파일로 dump (pipe buffer 회피)
   │
   ├─ cm find attribute / cm diff
   │     · 브랜치 owner attribute 로 담당자 확인
   │     · 코멘트가 빈 체크인도 파일 변경 요약을 Claude 입력에 포함
   │
   ├─ cm find merge
   │     · 전체 merge trace 로 main/beta 병합 여부 계산
   │     · 다른 브랜치를 거쳐 main/beta 에 들어간 변경도 병합됨으로 분류
   │
   ├─ 결정론적 섹션 계산 (코드)
   │     · 요약: 체크인 수, 코멘트 없음 수, 담당자/브랜치 목록
   │
   ├─ Anthropic Messages API
   │     · 모델: claude-sonnet-4-6
   │     · 도메인 카테고리 2~4개로 묶어 한국어 반말 요약
   │     · 시스템 프롬프트에 prompt caching 적용
   │
   └─ Discord 웹훅 발송
         · 단일 메시지 1900자 한도
         · 초과 시 카테고리 단위로 분할
```

## 리포트 구조

```
# 📋 일일 리포트 (YYYY-MM-DD 월)

## 📊 요약 (MM/DD 09:00 ~ MM/DD 09:00)
- 체크인 N건 (코멘트 없음 X건)
- 담당자 M명 : `김기민 N건`, `김호준 N건`, `미지정 N건`
- 브랜치 N건 : `main/beta`, `feature-branch`

## ✅ 변경점 (main 병합됨)

### 의미별 그룹명
> - `김기민` **키워드** - 디테일

## ⏳ 변경점 (미병합)

### 의미별 그룹명
> - `김호준` **키워드** - 디테일
```

- 요약은 코드로 결정론적 계산 (변동성 0)
- 주요 변경점만 Claude API 가 도메인 분류·요약

## 보안

- PlasticSCM SSO 토큰, Anthropic API 키, Discord 웹훅 URL 은 모두 GitHub Secrets 에서만 주입
- `.env` 는 로컬 PC 전용. `.gitignore` 로 차단
- Actions 로그에 secret 값이 보이면 GitHub 가 자동 마스킹

## 왜 클라우드인가

본인 PC 가 꺼져있어도 동작해야 했다. 결국 GitHub Actions cron 이 호스팅된 Linux runner 에서 cm CLI 로 PlasticSCM Cloud 에 접속해서 데이터를 가져오는 구조로 정착. 매일 한 번 약 2분, GitHub Actions 무료 quota 안에서 동작한다.
