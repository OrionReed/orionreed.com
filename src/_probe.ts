import { Num } from "./minim/values/num";
const x = Num.signal(0);
x.to(100, 0.5);  // does this exist on Num.signal()?
