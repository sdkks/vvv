# VVV (Veni Vidi Video)

VVV is a content aware video matching tool to find and nuke your duplicate videos to save disk space.

# Roadmap

- Support Videos
- Support Images
- Find duplicates by FS properties/stats and hashes
- Find duplicates by image content comparison methods
- Find videos by audio similarity matches
- Find partial matches, whether your small video clip is part of a bigger video file

# Development

```sh
make install   # install dependencies (also installs git hooks)
make hooks     # install git hooks explicitly
make ci        # typecheck + lint + build + test + secret scan
```

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/)
(enforced by commitlint via a `commit-msg` hook). The `pre-commit` hook runs
typecheck, lint, build, tests, and a gitleaks scan of staged changes.
Releases are versioned automatically with semantic-release.
