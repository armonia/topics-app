use super::*;

fn zone() -> HoverZone {
    let points = (0..5).map(|i| HoverPoint { x: 100.0 + i as f32 * 50.0, label: format!("p{i}") }).collect();
    HoverZone { x: 100.0, y: 60.0, w: 200.0, h: 34.0, points, reach: None }
}

fn width(s: &str) -> f32 {
    s.chars().count() as f32 * 6.0
}

#[test]
fn the_point_under_an_x_is_the_nearest_reading() {
    let z = zone();
    assert_eq!(z.at(100.0, 70.0).unwrap().label, "p0");
    assert_eq!(z.at(124.0, 70.0).unwrap().label, "p0");
    assert_eq!(z.at(126.0, 70.0).unwrap().label, "p1");
    assert_eq!(z.at(300.0, 70.0).unwrap().label, "p4");
}

#[test]
fn outside_the_plot_there_is_no_reading() {
    let z = zone();
    assert!(z.at(40.0, 70.0).is_none(), "far left of the plot");
    assert!(z.at(360.0, 70.0).is_none(), "far right of the plot");
    assert!(z.at(150.0, 20.0).is_none(), "above the title row");
    assert!(z.at(150.0, 130.0).is_none(), "below the axis");
    // the title row above the plot and the axis under it still answer
    assert!(z.at(150.0, 45.0).is_some() && z.at(150.0, 100.0).is_some());
}

#[test]
fn the_mark_has_the_line_over_the_plot_and_the_label_of_the_point() {
    let m = mark_at(&[zone()], 160.0, 70.0, &width, 540.0).unwrap();
    assert_eq!((m.line_x, m.top, m.bottom), (150.0, 60.0, 94.0));
    assert_eq!(m.label, "p1");
    assert!(m.box_y + m.box_h <= 60.0, "the label sits above the plot");
    assert!((m.box_x + m.box_w / 2.0 - 150.0).abs() < 0.01, "centred on the line");
}

#[test]
fn the_label_stays_inside_the_card_at_both_ends() {
    let left = mark_at(&[zone()], 100.0, 70.0, &width, 540.0).unwrap();
    assert!(left.box_x >= 4.0);
    let mut z = zone();
    z.points.last_mut().unwrap().label = "una etichetta molto lunga".into();
    let right = mark_at(&[z], 300.0, 70.0, &width, 320.0).unwrap();
    assert!(right.box_x + right.box_w <= 320.0 - 4.0 + 0.01, "{right:?}");
}

#[test]
fn a_zone_at_the_top_of_its_image_puts_the_label_inside_the_plot() {
    let mut z = zone();
    z.y = 10.0;
    let m = mark_at(&[z], 150.0, 20.0, &width, 540.0).unwrap();
    assert!(m.box_y >= 0.0);
}

#[test]
fn clocks_and_days_are_worded_in_italian() {
    // 2026-11-17 14:05 UTC+1 is a Tuesday
    assert_eq!(clock_label((20774 * 86_400) + 13 * 3600 + 5 * 60, 3600), "14:05");
    assert_eq!(day_label(20774), "mar 17");
}

#[test]
fn a_calendar_date_is_its_day_number() {
    assert_eq!(civil_day(1970, 1, 1), 0);
    assert_eq!(civil_day(2026, 11, 17), 20_774);
    assert_eq!(day_label(civil_day(2026, 11, 17)), "mar 17");
    assert_eq!(day_label(civil_day(2026, 2, 28) + 1), "dom 1");
}
