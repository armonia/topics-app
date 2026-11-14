//! The machine detail card from fake `/api/machines` answers. Card ad8b474a.

use super::*;

const MACHINES: &str = r#"[
 {"id":"pc","lines":["Si sta addormentando"],"metrics":[
   {"key":"cpu","name":"CPU","pct":40,"level":0,"note":"adesso","history":[{"t":1000,"v":10},{"t":2000,"v":60},{"t":3000,"v":30}]},
   {"key":"disk","name":"Disco","pct":97,"level":2,"note":"27 GB liberi","history":[]}],
  "timeline":{"window":3000,"segments":[{"t0":0,"t1":1500,"state":"lavora"},{"t0":1500,"t1":3000,"state":"chiuso"}]}},
 {"id":"cloud","lines":["Ultimo lavoro: x, 9 nov"],"metrics":[{"key":"spend","name":"Spesa","pct":14,"level":2,"value":"8,44/60 €","note":"oltre il tetto","history":[]}],
  "timeline":{"window":3000,"segments":[{"t0":0,"t1":3000,"state":"spento"}]}},
 {"id":"bare","metrics":[]}]"#;

/// Pixels that differ between two pictures of the same size: what a part adds.
fn diff(a: &Pic, b: &Pic) -> usize {
    assert_eq!(a.cv.px.len(), b.cv.px.len(), "same size");
    a.cv.px.iter().zip(&b.cv.px).filter(|(x, y)| x != y).count()
}

#[test]
fn details_parse_history_timeline_spend_and_lines() {
    let d = machine_details(MACHINES);
    assert_eq!(d.len(), 3);
    assert_eq!(d[0].metrics[0].history.len(), 3);
    assert_eq!(d[0].segments.len(), 2);
    assert_eq!(d[1].metrics[0].value, "8,44/60 €");
    assert_eq!(d[1].lines, ["Ultimo lavoro: x, 9 nov"]);
    assert!(has_graphics(&d[0]) && has_graphics(&d[1]) && !has_graphics(&d[2]));
    assert!(machine_details("nope").is_empty());
}

#[test]
fn the_chart_and_the_state_band_add_ink_and_height() {
    let p = Palette::new(true);
    let d = machine_details(MACHINES);
    let full = draw_machine_detail(&d[0], p);
    let mut plain = d[0].clone();
    for m in &mut plain.metrics {
        m.history.clear();
    }
    assert!(diff(&full, &draw_machine_detail(&plain, p)) > 200, "the 24 h chart is drawn");
    let mut no_band = d[0].clone();
    no_band.segments.clear();
    assert!(detail_height(&d[0]) > detail_height(&no_band), "the state row takes room");
    assert!(draw_machine_detail(&no_band, p).cv.h < full.cv.h, "the band is part of the picture");
    assert!(draw_machine_detail(&d[1], p).to_png().is_some());
}
