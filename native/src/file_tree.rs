use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use ignore::{DirEntry, WalkBuilder};
use napi::bindgen_prelude::AsyncTask;
use napi::Task;
use napi_derive::napi;
use time::OffsetDateTime;
use unicode_normalization::UnicodeNormalization;

#[napi(object)]
#[derive(Clone)]
pub struct FileNode {
    pub name: String,
    #[napi(js_name = "type")]
    pub kind: String,
    pub path: String,
    pub size: Option<f64>,
    pub modified: Option<String>,
    pub children: Option<Vec<FileNode>>,
}

struct EntryNode {
    depth: usize,
    node: FileNode,
}

pub struct FileTreeTask {
    root: String,
    depth: u32,
    home: Option<String>,
}

impl Task for FileTreeTask {
    type Output = Vec<FileNode>;
    type JsValue = Vec<FileNode>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        compute_file_tree(&self.root, self.depth, self.home.as_deref())
            .map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn walk_file_tree(root: String, depth: u32, home: Option<String>) -> AsyncTask<FileTreeTask> {
    AsyncTask::new(FileTreeTask { root, depth, home })
}

fn compute_file_tree(root: &str, depth: u32, home: Option<&str>) -> Result<Vec<FileNode>, Box<dyn std::error::Error + Send + Sync>> {
    let root = PathBuf::from(root);
    let home = home.map(PathBuf::from).or_else(home_dir);
    let mut builder = WalkBuilder::new(&root);
    builder
        .standard_filters(false)
        .hidden(false)
        .ignore(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(depth.max(1) as usize))
        .filter_entry({
            let filter_root = root.clone();
            let filter_home = home.clone();
            move |entry| keep_entry(entry, &filter_root, filter_home.as_deref())
        });

    let mut entries = Vec::new();
    for result in builder.build() {
        let entry = result?;
        if entry.depth() == 0 { continue; }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(path).ok();
        let file_type = metadata.as_ref().map(|metadata| metadata.file_type()).or_else(|| entry.file_type()).ok_or("entry type unavailable")?;
        let is_dir = file_type.is_dir();
        if !is_dir && !file_type.is_file() { continue; }
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name.to_owned(),
            None => continue,
        };
        let children = if is_dir && entry.depth() < depth as usize && !is_protected(path, &root, home.as_deref()) {
            Some(Vec::new())
        } else {
            None
        };
        let modified = if is_dir { None } else { metadata.as_ref().and_then(|metadata| metadata.modified().ok()).and_then(to_iso) };
        entries.push(EntryNode {
            depth: entry.depth(),
            node: FileNode {
                name,
                kind: if is_dir { "dir" } else { "file" }.to_owned(),
                path: path.to_string_lossy().into_owned(),
                size: if is_dir { None } else { metadata.as_ref().map(|metadata| metadata.len() as f64) },
                modified,
                children,
            },
        });
    }

    let mut roots = Vec::new();
    let mut stack: Vec<EntryNode> = Vec::new();
    for entry in entries {
        while stack.last().is_some_and(|parent| parent.depth >= entry.depth) {
            attach(&mut roots, &mut stack);
        }
        stack.push(entry);
    }
    while !stack.is_empty() { attach(&mut roots, &mut stack); }
    Ok(roots)
}

fn attach(roots: &mut Vec<FileNode>, stack: &mut Vec<EntryNode>) {
    let Some(entry) = stack.pop() else { return; };
    if let Some(parent) = stack.last_mut() {
        if let Some(children) = parent.node.children.as_mut() { children.push(entry.node); }
    } else {
        roots.push(entry.node);
    }
}

fn keep_entry(entry: &DirEntry, root: &Path, home: Option<&Path>) -> bool {
    if entry.depth() == 0 { return true; }
    let Some(name) = entry.file_name().to_str() else { return false; };
    if name == ".git" || name == ".DS_Store" || name == ".topics-secrets" { return false; }
    if entry.file_type().is_some_and(|kind| kind.is_dir()) && is_heavy(name) { return false; }
    !entry.file_type().is_some_and(|kind| kind.is_dir())
        || !is_protected(entry.path(), root, home)
        || is_protected_area_root(entry.path(), home)
}

fn is_heavy(name: &str) -> bool {
    matches!(name, "node_modules" | ".next" | "dist" | "build" | "__pycache__" | ".cache" | ".turbo"
        | ".vercel" | ".output" | "coverage" | ".nyc_output" | ".parcel-cache" | "target")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn path_starts_with(path: &Path, base: &Path) -> bool {
    if cfg!(windows) || cfg!(target_os = "macos") {
        let path = fold(&path.to_string_lossy());
        let base = fold(&base.to_string_lossy());
        path == base || path.strip_prefix(&base).is_some_and(|rest| rest.starts_with(std::path::MAIN_SEPARATOR))
    } else {
        path.starts_with(base)
    }
}

fn fold(value: &str) -> String {
    if cfg!(windows) || cfg!(target_os = "macos") {
        value.nfkc().flat_map(char::to_uppercase).flat_map(char::to_lowercase).collect()
    } else {
        value.to_owned()
    }
}

fn protected_areas(path: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let mut areas = Vec::new();
    if let Some(home) = home {
        let library = home.join("Library");
        if path_starts_with(path, &library) {
            areas.push(library.clone());
            for name in ["Containers", "Group Containers", "Mail", "Messages", "Safari", "Calendars"] {
                let area = library.join(name);
                if path_starts_with(path, &area) { areas.push(area); }
            }
        }
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::Normal(name) => {
                current.push(name);
                let name = fold(&name.to_string_lossy());
                if [".photoslibrary", ".photolibrary", ".migratedphotolibrary", ".aplibrary", ".musiclibrary", ".tvlibrary"].iter().any(|suffix| name.ends_with(suffix))
                    || name == "photo booth library"
                {
                    areas.push(current.clone());
                }
            }
            Component::CurDir | Component::ParentDir => current.push(component.as_os_str()),
        }
    }
    areas
}

fn is_protected(path: &Path, root: &Path, home: Option<&Path>) -> bool {
    let root_areas = protected_areas(root, home);
    protected_areas(path, home).into_iter().any(|area| {
        path_starts_with(path, &area) && !root_areas.iter().any(|root_area| path_starts_with(root, root_area) && path_starts_with(root_area, &area))
    })
}

fn is_protected_area_root(path: &Path, home: Option<&Path>) -> bool {
    protected_areas(path, home).iter().any(|area| path_starts_with(path, area) && path_starts_with(area, path))
}

fn to_iso(time: std::time::SystemTime) -> Option<String> {
    let nanos = time.duration_since(UNIX_EPOCH).ok()?.as_nanos() as i128;
    let date = OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    static FORMAT: OnceLock<time::format_description::FormatDescriptionV3<'static>> = OnceLock::new();
    let format = FORMAT.get_or_init(|| {
        time::format_description::parse_borrowed::<3>("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z")
            .expect("file-tree timestamp format is valid")
    });
    date.format(format).ok()
}
