// Continuous behaviors over a single signal — re-export from
// `signals/behaviors`. Lives in `motion/` for discoverability alongside
// transitions/easings/clocks/choreographers.

export {
  spring,
  oscillate,
  drift,
  attract,
  type SpringOpts,
} from "../signals/behaviors";
