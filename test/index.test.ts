import { describe, expect, it } from "vitest";
import { COMMAND_NAME, PROTOCOL_VERSION, instanceLabel } from "../src/index.js";

describe("constantes del protocolo", () => {
  it("expone la versión 1 y el comando /orbit", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(COMMAND_NAME).toBe("orbit");
  });
});

describe("instanceLabel", () => {
  it("usa el último segmento de una ruta POSIX", () => {
    expect(instanceLabel("/Users/juan/Documents/GitHub/Orbit")).toBe("Orbit");
  });

  it("acepta rutas de Windows y barras finales", () => {
    expect(instanceLabel("C:\\repos\\orbit\\")).toBe("orbit");
  });

  it("devuelve unknown para una ruta vacía", () => {
    expect(instanceLabel("")).toBe("unknown");
  });
});
