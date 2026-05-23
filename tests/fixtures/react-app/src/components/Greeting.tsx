import React, { useState } from "react";
import { formatName } from "../lib/format";

export interface GreetingProps {
  name: string;
  initialCount?: number;
}

/**
 * Greets the user and counts clicks.
 */
export function Greeting(props: GreetingProps) {
  const [count, setCount] = useState(props.initialCount ?? 0);
  return (
    <div>
      <h1>Hello, {formatName(props.name)}!</h1>
      <button onClick={() => setCount(count + 1)}>Clicks: {count}</button>
    </div>
  );
}

export const Farewell = (props: { name: string }) => (
  <span>Goodbye, {props.name}</span>
);
