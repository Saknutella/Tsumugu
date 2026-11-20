# 同步上游前的只读检查(不自动合并,不碰工作区)
#
# 这个 fork 的 remote 布局:
#   upstream → monochrome-music/monochrome(只读,拉更新)
#   origin   → 自己的 fork(推送;由用户创建后 git remote add origin <url>)
#
# 先 fetch + 看清"上游改了什么、我们领先多少",再决定是否 merge;直接 merge 会把
# 品牌/精简改动和上游改动混在一次冲突里,很难判断哪边该保留。所以本脚本默认只报告。
#
# 用法:
#   pwsh scripts/upstream-sync.ps1            # fetch + 报告
#   pwsh scripts/upstream-sync.ps1 -NoFetch   # 不联网,只看已有 upstream/main
#   pwsh scripts/upstream-sync.ps1 -Merge     # 报告后执行 git merge upstream/main(要求工作区干净)

[CmdletBinding()]
param(
    [switch]$NoFetch,
    [switch]$Merge
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not (Test-Path '.git')) {
        throw "当前目录不是 git 仓库:$root"
    }
    $remotes = git remote
    if ($remotes -notcontains 'upstream') {
        throw '缺少 remote `upstream`;先执行:git remote add upstream https://github.com/monochrome-music/monochrome.git'
    }

    if (-not $NoFetch) {
        Write-Host '== git fetch upstream ==' -ForegroundColor Cyan
        git fetch upstream --prune
    }

    $behind = [int](git rev-list --count 'HEAD..upstream/main')
    $ahead = [int](git rev-list --count 'upstream/main..HEAD')
    $head = git rev-parse --short HEAD
    $upstreamHead = git rev-parse --short upstream/main
    Write-Host ''
    Write-Host "HEAD=$head  upstream/main=$upstreamHead" -ForegroundColor Gray
    Write-Host "落后 $behind 个上游提交,领先 $ahead 个本地提交" -ForegroundColor Yellow

    if ($behind -eq 0) {
        Write-Host '上游没有新提交,无需同步。' -ForegroundColor Green
        return
    }

    Write-Host ''
    Write-Host '== 上游新提交 ==' -ForegroundColor Cyan
    git log --oneline --no-decorate 'HEAD..upstream/main'
    Write-Host ''
    Write-Host '== 上游改动范围(相对当前 HEAD)==' -ForegroundColor Cyan
    git diff --stat 'HEAD...upstream/main'

    if ($Merge) {
        $dirty = git status --porcelain
        if ($dirty) {
            throw '工作区有未提交改动,拒绝自动 merge。先提交/暂存,再手工合并。'
        }
        Write-Host ''
        Write-Host '== git merge upstream/main ==' -ForegroundColor Cyan
        git merge --no-edit upstream/main
        if ($LASTEXITCODE -ne 0) {
            Write-Host '合并冲突:按 docs/03-upstream-sync.md 的冲突处理原则手工解决。' -ForegroundColor Red
            exit $LASTEXITCODE
        }
        Write-Host '合并完成。下一步:node verify/check.mjs && node verify/kind.mjs' -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host '只看报告,没有改动任何文件。确认后再执行:pwsh scripts/upstream-sync.ps1 -NoFetch -Merge' -ForegroundColor Gray
    }
}
finally {
    Pop-Location
}
