use std::collections::BTreeMap;

use napi::bindgen_prelude::AsyncTask;
use napi::Task;
use napi_derive::napi;

#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[napi(js_name = "gitHeadCommitId")]
pub fn git_head_commit_id(repo_path: String) -> Option<String> {
    let repo = gix::discover(repo_path).ok()?;
    let commit = repo.head_commit().ok()?;
    Some(commit.id().to_string())
}

#[napi(object)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String,
    pub orig_path: Option<String>,
}

#[napi(object)]
pub struct LastCommit {
    pub short: String,
    pub hash: String,
    pub subject: String,
    pub author: String,
}

#[napi(object)]
pub struct GitStatus {
    pub root: String,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitStatusEntry>,
    pub last_commit: Option<LastCommit>,
}

pub struct GitStatusTask {
    repo_path: String,
}

impl Task for GitStatusTask {
    type Output = Option<GitStatus>;
    type JsValue = Option<GitStatus>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        compute_git_status(&self.repo_path).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn git_status(repo_path: String) -> AsyncTask<GitStatusTask> {
    AsyncTask::new(GitStatusTask { repo_path })
}

fn compute_git_status(repo_path: &str) -> Result<Option<GitStatus>, Box<dyn std::error::Error + Send + Sync>> {
    let repo = match gix::discover(repo_path) {
        Ok(repo) => repo,
        Err(err) if err.is_not_found() => return Ok(None),
        Err(err) => return Err(Box::new(err)),
    };
    let canonical_root = std::fs::canonicalize(repo.workdir().ok_or("repository has no working tree")?)?;
    let root = canonical_root.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");

    let mut staged: BTreeMap<String, (char, Option<String>)> = BTreeMap::new();
    let mut unstaged: BTreeMap<String, char> = BTreeMap::new();
    let mut untracked = Vec::new();
    let mut status = repo
        .status(gix::progress::Discard)?
        .into_iter(Vec::new())?;
    while let Some(item) = status.next() {
        let item = item?;
        match item {
            gix::status::Item::TreeIndex(change) => match change {
                gix::diff::index::ChangeRef::Addition { location, .. } => {
                    staged.insert(path_string(&location), ('A', None));
                }
                gix::diff::index::ChangeRef::Deletion { location, .. } => {
                    staged.insert(path_string(&location), ('D', None));
                }
                gix::diff::index::ChangeRef::Modification { location, previous_entry_mode, entry_mode, .. } => {
                    let code = if previous_entry_mode != entry_mode
                        && !is_executable_mode_change(previous_entry_mode, entry_mode)
                    {
                        'T'
                    } else {
                        'M'
                    };
                    staged.insert(path_string(&location), (code, None));
                }
                gix::diff::index::ChangeRef::Rewrite { source_location, location, copy, .. } => {
                    staged.insert(
                        path_string(&location),
                        (if copy { 'C' } else { 'R' }, Some(path_string(&source_location))),
                    );
                }
            },
            gix::status::Item::IndexWorktree(change) => {
                let change_path = path_string(change.rela_path());
                match change.summary() {
                    Some(gix::status::index_worktree::iter::Summary::Added) => {
                        let mut path = change_path;
                        if matches!(change, gix::status::index_worktree::Item::DirectoryContents { entry, .. } if entry.disk_kind == Some(gix::dir::entry::Kind::Directory)) {
                            path.push('/');
                        }
                        untracked.push(path);
                    }
                    Some(gix::status::index_worktree::iter::Summary::Removed) => {
                        unstaged.insert(change_path, 'D');
                    }
                    Some(gix::status::index_worktree::iter::Summary::Modified) => {
                        unstaged.insert(change_path, 'M');
                    }
                    Some(gix::status::index_worktree::iter::Summary::TypeChange) => {
                        unstaged.insert(change_path, 'T');
                    }
                    Some(gix::status::index_worktree::iter::Summary::IntentToAdd) => {
                        unstaged.insert(change_path, 'A');
                    }
                    Some(gix::status::index_worktree::iter::Summary::Conflict) => {
                        let code = match change {
                            gix::status::index_worktree::Item::Modification { status, .. } => match status {
                                gix::status::plumbing::index_as_worktree::EntryStatus::Conflict { summary, .. } => match summary {
                                    gix::status::plumbing::index_as_worktree::Conflict::BothDeleted => "DD",
                                    gix::status::plumbing::index_as_worktree::Conflict::AddedByUs => "AU",
                                    gix::status::plumbing::index_as_worktree::Conflict::DeletedByThem => "UD",
                                    gix::status::plumbing::index_as_worktree::Conflict::AddedByThem => "UA",
                                    gix::status::plumbing::index_as_worktree::Conflict::DeletedByUs => "DU",
                                    gix::status::plumbing::index_as_worktree::Conflict::BothAdded => "AA",
                                    gix::status::plumbing::index_as_worktree::Conflict::BothModified => "UU",
                                },
                                _ => "UU",
                            },
                            _ => "UU",
                        };
                        let path = change_path;
                        staged.insert(path.clone(), (code.chars().next().unwrap_or('U'), None));
                        unstaged.insert(path, code.chars().nth(1).unwrap_or('U'));
                    }
                    _ => {}
                }
            }
        }
    }

    let mut paths: BTreeMap<String, GitStatusEntry> = BTreeMap::new();
    for (path, (x, orig_path)) in staged {
        paths.insert(path.clone(), GitStatusEntry {
            path,
            status: format!("{} ", x),
            orig_path,
        });
    }
    for (path, y) in unstaged {
        let entry = paths.entry(path.clone()).or_insert_with(|| GitStatusEntry {
            path,
            status: "  ".to_owned(),
            orig_path: None,
        });
        entry.status.replace_range(1..2, &y.to_string());
    }
    // A conflicted path sits in the index only at stages 1-3, and on a
    // case-sensitive file system gix's walk also reports its worktree file
    // as untracked (Linux CI, 15/10: "DU ud.txt" and "?? ud.txt"). Git never
    // lists a path twice.
    untracked.retain(|path| !paths.contains_key(path));
    let mut entries: Vec<_> = paths.into_values().collect();
    untracked.sort();
    entries.extend(untracked.into_iter().map(|path| GitStatusEntry {
        path,
        status: "??".to_owned(),
        orig_path: None,
    }));

    let head_name = repo.head_name()?;
    let branch = head_name.as_ref().map(|name| name.shorten().to_string());
    let head_commit = match repo.head_commit() {
        Ok(commit) => Some(commit),
        Err(err) if err.is_not_found() => None,
        Err(err) => return Err(Box::new(err)),
    };
    let (ahead, behind) = match (head_commit.as_ref(), head_name.as_ref()) {
        (Some(head), Some(name)) => divergence(&repo, head.id, name)?,
        _ => (0, 0),
    };
    let last_commit = match head_commit {
        Some(commit) => {
            let decoded = commit.decode()?;
            let message = decoded.message();
            let subject = message.summary().to_string();
            let author = decoded.author()?.name.to_string();
            Some(LastCommit {
                short: commit.short_id()?.to_string(),
                hash: commit.id().to_string(),
                subject,
                author,
            })
        }
        None => None,
    };

    Ok(Some(GitStatus { root, branch, ahead, behind, entries, last_commit }))
}

fn path_string(path: &gix::bstr::BStr) -> String {
    path.to_string()
}

fn is_executable_mode_change(previous: gix::index::entry::Mode, current: gix::index::entry::Mode) -> bool {
    (previous == gix::index::entry::Mode::FILE && current == gix::index::entry::Mode::FILE_EXECUTABLE)
        || (previous == gix::index::entry::Mode::FILE_EXECUTABLE && current == gix::index::entry::Mode::FILE)
}

fn divergence(
    repo: &gix::Repository,
    head: gix::ObjectId,
    branch: &gix::refs::FullName,
) -> Result<(u32, u32), Box<dyn std::error::Error + Send + Sync>> {
    let Some(upstream_name) = repo.branch_remote_tracking_ref_name(branch.as_ref(), gix::remote::Direction::Fetch) else {
        return Ok((0, 0));
    };
    let upstream = match repo.find_reference(upstream_name?.as_ref()) {
        Ok(mut reference) => match reference.peel_to_commit() {
            Ok(commit) => commit.id,
            Err(err) if err.is_not_found() => return Ok((0, 0)),
            Err(err) => return Err(Box::new(err)),
        },
        Err(err) if err.is_not_found() => return Ok((0, 0)),
        Err(err) => return Err(Box::new(err)),
    };
    if head == upstream {
        return Ok((0, 0));
    }
    // Each side is walked only down to what the other side reaches, like
    // git's own count: the cost follows the divergence, not the history
    // (two full walks of 10,587 commits for a branch in sync, before).
    let ahead = count_unique(repo, head, upstream)?;
    let behind = count_unique(repo, upstream, head)?;
    Ok((ahead, behind))
}

fn count_unique(
    repo: &gix::Repository,
    tip: gix::ObjectId,
    hidden: gix::ObjectId,
) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    let mut count = 0;
    for info in repo.rev_walk([tip]).with_hidden([hidden]).all()? {
        info?;
        count += 1;
    }
    Ok(count)
}
