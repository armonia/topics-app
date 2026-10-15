use std::{collections::BTreeMap, path::Path};

use napi::bindgen_prelude::AsyncTask;
use napi::Task;
use napi_derive::napi;
use gix::bstr::ByteSlice;

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
    pub time: i64,
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

#[napi(object)]
pub struct GitNumstatEntry {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
}

#[napi(object)]
pub struct GitNumstat {
    pub staged: Vec<GitNumstatEntry>,
    pub unstaged: Vec<GitNumstatEntry>,
    pub unsupported: Vec<String>,
}

pub struct GitNumstatTask {
    repo_path: String,
}

impl Task for GitNumstatTask {
    type Output = GitNumstat;
    type JsValue = GitNumstat;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        compute_git_numstat(&self.repo_path).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn git_numstat(repo_path: String) -> AsyncTask<GitNumstatTask> {
    AsyncTask::new(GitNumstatTask { repo_path })
}

#[derive(Clone, Copy)]
struct BlobEntry {
    id: gix::ObjectId,
    mode: gix::object::tree::EntryKind,
}

fn compute_git_numstat(repo_path: &str) -> Result<GitNumstat, Box<dyn std::error::Error + Send + Sync>> {
    let Some(status) = compute_git_status(repo_path)? else {
        return Ok(GitNumstat { staged: Vec::new(), unstaged: Vec::new(), unsupported: Vec::new() });
    };
    let repo = gix::discover(repo_path)?;
    let worktree = repo.workdir().ok_or("repository has no working tree")?.to_path_buf();
    let index = repo.index_or_empty()?;
    let head_tree = repo.head_tree_id_or_empty()?;
    let head_index = repo.index_from_tree(&head_tree)?;
    let head = head_index.entries_with_paths_by_filter_map(|_path, entry| {
        if entry.stage_raw() != 0 { return None; }
        Some(BlobEntry { id: entry.id, mode: entry.mode.to_tree_entry_mode()?.kind() })
    }).map(|(path, entry)| (path.to_string(), entry)).collect::<BTreeMap<_, _>>();
    let current = index.entries_with_paths_by_filter_map(|_path, entry| {
        if entry.stage_raw() != 0 { return None; }
        Some(BlobEntry { id: entry.id, mode: entry.mode.to_tree_entry_mode()?.kind() })
    }).map(|(path, entry)| (path.to_string(), entry)).collect::<BTreeMap<_, _>>();

    let mut staged = BTreeMap::new();
    let mut unstaged = BTreeMap::new();
    let mut unsupported = Vec::new();
    let mut staged_cache = repo.diff_resource_cache(
        gix::diff::blob::pipeline::Mode::ToGit,
        Default::default(),
    )?;
    let mut unstaged_cache = repo.diff_resource_cache(
        gix::diff::blob::pipeline::Mode::ToGit,
        gix::diff::blob::pipeline::WorktreeRoots { old_root: None, new_root: Some(worktree.clone()) },
    )?;
    let null_id = repo.object_hash().null();

    for entry in status.entries {
        let path = entry.path;
        let staged_change = entry.status.as_bytes().first().is_some_and(|code| *code != b' ' && *code != b'?');
        let unstaged_change = entry.status.as_bytes().get(1).is_some_and(|code| *code != b' ' && *code != b'?');
        if entry.status.contains('U') {
            unsupported.push(path);
            continue;
        }
        if staged_change {
            let old_path = entry.orig_path.as_deref().unwrap_or(&path);
            let old = head.get(old_path).copied();
            let new = current.get(&path).copied();
            match diff_numstat(&repo, &mut staged_cache, old, new, old_path, &path, &null_id, None) {
                Some(stat) => { staged.insert(path.clone(), stat); }
                None => unsupported.push(path.clone()),
            }
        }
        if unstaged_change {
            let old = current.get(&path).copied();
            match diff_numstat(&repo, &mut unstaged_cache, old, old, &path, &path, &null_id, Some(&worktree)) {
                Some(stat) => { unstaged.insert(path.clone(), stat); }
                None => unsupported.push(path),
            }
        }
    }

    Ok(GitNumstat {
        staged: staged.into_iter().map(|(path, (added, removed, binary))| GitNumstatEntry { path, added, removed, binary }).collect(),
        unstaged: unstaged.into_iter().map(|(path, (added, removed, binary))| GitNumstatEntry { path, added, removed, binary }).collect(),
        unsupported,
    })
}

fn diff_numstat(
    repo: &gix::Repository,
    cache: &mut gix::diff::blob::Platform,
    old: Option<BlobEntry>,
    new: Option<BlobEntry>,
    old_path: &str,
    new_path: &str,
    null_id: &gix::ObjectId,
    worktree_root: Option<&Path>,
) -> Option<(u32, u32, bool)> {
    let (old_entry, new_entry) = match (old, new) {
        (None, None) => return Some((0, 0, false)),
        (Some(old), Some(new)) if old.mode == gix::object::tree::EntryKind::Commit || new.mode == gix::object::tree::EntryKind::Commit => {
            let new_id = if let Some(root) = worktree_root {
                let submodule = gix::discover(root.join(new_path)).ok()?;
                let id = submodule.head_commit().ok()?.id().detach();
                id
            } else {
                new.id
            };
            return Some(if old.id == new_id { (0, 0, false) } else { (1, 1, false) });
        }
        (Some(old), Some(new)) if worktree_root.is_none() && old.id == new.id && old.mode == new.mode => return Some((0, 0, false)),
        pair => pair,
    };
    if matches!(old_entry, Some(entry) if entry.mode == gix::object::tree::EntryKind::Tree)
        || matches!(new_entry, Some(entry) if entry.mode == gix::object::tree::EntryKind::Tree)
    {
        return None;
    }
    let mode = old_entry.or(new_entry)?.mode;
    let old_id = old_entry.map_or(*null_id, |entry| entry.id);
    let new_id = new_entry.map_or(*null_id, |entry| entry.id);
    let old_path = old_path.as_bytes().as_bstr();
    let new_path = new_path.as_bytes().as_bstr();
    cache.clear_resource_cache_keep_allocation();
    cache.set_resource(old_id, mode, old_path, gix::diff::blob::ResourceKind::OldOrSource, &repo.objects).ok()?;
    cache.set_resource(new_id, mode, new_path, gix::diff::blob::ResourceKind::NewOrDestination, &repo.objects).ok()?;
    let outcome = cache.prepare_diff().ok()?;
    match outcome.operation {
        gix::diff::blob::platform::prepare_diff::Operation::SourceOrDestinationIsBinary => Some((0, 0, true)),
        gix::diff::blob::platform::prepare_diff::Operation::InternalDiff { .. } => {
            let input = gix::diff::blob::InternedInput::new(
                outcome.old.intern_source(),
                outcome.new.intern_source(),
            );
            let diff = gix::diff::blob::Diff::compute(gix::diff::blob::Algorithm::MyersMinimal, &input);
            let added = diff.count_additions();
            let removed = diff.count_removals();
            if worktree_root.is_some() && old_entry.is_some_and(|old| Some(old.mode) == new_entry.map(|new| new.mode)) && added == 0 && removed == 0 {
                None
            } else {
                Some((added, removed, false))
            }
        }
        gix::diff::blob::platform::prepare_diff::Operation::ExternalCommand { .. } => None,
    }
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
                time: decoded.author()?.seconds(),
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
