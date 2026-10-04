[简体中文](release-notes-v0.2.0.md)

## New Location Layer: Navigation Waypoints

- **Location layer**: Mark up to ten navigation waypoints (`A`–`J`) with positions and headings. Rename, adjust coordinates or headings, hide all markers, or clear one; drag placement and clearing support undo and redo.
- **Waypoint file**: Save only placed waypoints to a separate YAML. Opening a map tries to load `waypoints.yaml` from the same directory; manual import is also available. Import checks the map details.
- **Nav2 integration**: A ROS 2 program can read a waypoint, build a `geometry_msgs/msg/PoseStamped` in the `map` frame, and navigate with Nav2's [Simple Commander `goToPose`](https://docs.nav2.org/rolling/configuration_and_development/simple_commander_api/simple_commander_api/).

## Notes

- Drag placement checks only whether the press point is inside the map and not an occupied cell; manually entered coordinates bypass this check. Keepout areas and robot reachability need separate review.
- With a nonzero map `origin.theta`, dragged headings do not yet account for that rotation. Review exported headings before use.

## Demo

![Location layer and preset navigation waypoint editing interface](editor-interface.png)

_Figure 1. Location layer and preset navigation waypoint editing interface._

![Preset navigation waypoint illustration in RViz/Nav2](nav2-waypoints-illustration.png)

_Figure 2. Preset navigation waypoint illustration in RViz/Nav2._
