# 교통비정산서 프로젝트 작업 규칙

## 기술 스택
- Node.js HTTP 서버 (server.js, ESM, 프레임워크 없음)
- 순수 HTML/CSS/Vanilla JS 프론트엔드 (단일 파일: public/index.html)
- GitHub API (`db` 브랜치 `db.json`)를 DB로 사용
- 로컬 포트: 3014

## 브랜치 워크플로우 (필수)

**main 브랜치는 항상 배포 가능 상태를 유지한다.**  
모든 신규 기능은 feature 브랜치에서 개발한다.

```bash
# 1. feature 브랜치 생성
git checkout -b feature/기능명

# 2. 개발 + 로컬 테스트 (node server.js → http://localhost:3014)

# 3. 커밋 & push (Vercel Preview URL 자동 생성)
git add <files>
git commit -m "기능명: 변경 내용"
git push -u origin feature/기능명

# 4. 검증 완료 후 main에 병합
git checkout main
git merge --no-ff feature/기능명
git push origin main   # → Vercel 자동 배포

# 5. 브랜치 정리
git branch -d feature/기능명
git push origin --delete feature/기능명
```

## 브랜치 명명
- 신규 기능: `feature/기능명` (예: `feature/export-excel`)
- 버그 수정: `fix/버그명`
- 긴급 수정: `hotfix/내용`

## 관련 문서
- **현재 상태 빠른 파악**: `06_최신인수인계/00_인덱스.md`
- 전체 이력: `06_최신인수인계/01_2026-08-11_초기구축~25차.md`
- 워크스페이스 가이드: `../WORKSPACE.md`
