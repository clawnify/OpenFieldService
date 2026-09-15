import { render } from "preact";
import { App } from "./app";
import "./tokens.css";
import "./styles.css";

render(<App />, document.getElementById("app")!);
