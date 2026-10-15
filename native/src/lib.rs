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
