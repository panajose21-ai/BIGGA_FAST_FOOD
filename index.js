require("dotenv").config();
const express = require("express");
const axios = require("axios");
const menu = require("./menu");

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  OWNER_PHONE,
  LOGO_URL,
  PORT = 3000,
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

const sesiones = new Map();

function formatearPrecio(precio) {
  return precio.toLocaleString("es-CO");
}

function textoMenu() {
  let texto = "🍔 *BIGGA FAST FOOD* 🍔\n\n";
  menu.forEach((item) => {
    texto += `*${item.id}.* ${item.nombre} - $${formatearPrecio(item.precio)}\n`;
  });
  texto += "\nEscribe los *numeros* de lo que quieres, separados por coma.\n";
  texto += 'Ejemplo: "1,3,5" (1 Bigga Cheddar Fresa, 1 Bigga Crispy Onion, 1 refresco)';
  return texto;
}

function interpretarPedido(mensaje) {
  const partes = mensaje
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const items = [];
  let total = 0;
  let huboError = false;

  partes.forEach((id) => {
    const item = menu.find((m) => m.id === id);
    if (item) {
      items.push(item);
      total += item.precio;
    } else {
      huboError = true;
    }
  });

  return { items, total, huboError };
}

function resumenPedido(items, total) {
  let texto = "🧾 *Tu pedido:*\n\n";
  items.forEach((item) => {
    texto += `- ${item.nombre} ($${formatearPrecio(item.precio)})\n`;
  });
  texto += `\n*Total: $${formatearPrecio(total)}*\n\n`;
  texto += 'Responde *"si"* para confirmar o *"no"* para volver a empezar.';
  return texto;
}

async function enviarMensaje(numero, texto) {
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to: numero,
        type: "text",
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "Error enviando mensaje:",
      error.response ? error.response.data : error.message
    );
  }
}

async function enviarImagen(numero, urlImagen, caption = "") {
  if (!urlImagen) return;
  try {
    await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to: numero,
        type: "image",
        image: { link: urlImagen, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "Error enviando imagen:",
      error.response ? error.response.data : error.message
    );
  }
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const entry = req.body.entry?.[0];
  const cambio = entry?.changes?.[0];
  const mensaje = cambio?.value?.messages?.[0];

  if (!mensaje || mensaje.type !== "text") return;

  const numeroCliente = mensaje.from;
  const texto = mensaje.text.body.trim().toLowerCase();

  let sesion = sesiones.get(numeroCliente) || { estado: "inicio" };

  if (texto === "menu") {
    await enviarMensaje(numeroCliente, textoMenu());
    sesion.estado = "eligiendo";
    sesiones.set(numeroCliente, sesion);
    return;
  }

  if (texto === "cancelar") {
    sesiones.delete(numeroCliente);
    await enviarMensaje(numeroCliente, "Pedido cancelado. Escribe *menu* cuando quieras empezar de nuevo.");
    return;
  }

  switch (sesion.estado) {
    case "inicio": {
      await enviarImagen(numeroCliente, LOGO_URL, "🍔 BIGGA FAST FOOD 🍔");
      await enviarMensaje(
        numeroCliente,
        "👋 ¡Hola! Bienvenido a Bigga Fast Food.\n📍 Cra 16 - Calle 21, Saravena\n📞 321 467 5969\n\nAqui puedes ver el menu y hacer tu pedido."
      );
      await enviarMensaje(numeroCliente, textoMenu());
      sesion.estado = "eligiendo";
      break;
    }

    case "eligiendo": {
      const { items, total, huboError } = interpretarPedido(texto);

      if (items.length === 0) {
        await enviarMensaje(
          numeroCliente,
          'No entendi tu pedido. Escribe los numeros del menu separados por coma, ej: "1,3"'
        );
        break;
      }

      if (huboError) {
        await enviarMensaje(
          numeroCliente,
          "⚠️ Algunos numeros no los reconoci, pero tome en cuenta los validos:"
        );
      }

      sesion.pedidoActual = { items, total };
      sesion.estado = "confirmando";
      await enviarMensaje(numeroCliente, resumenPedido(items, total));
      break;
    }

    case "confirmando": {
      if (texto === "si" || texto === "sí") {
        const { items, total } = sesion.pedidoActual;

        await enviarMensaje(
          numeroCliente,
          "✅ ¡Pedido confirmado! Te avisaremos cuando este listo. Gracias por tu compra 🙌"
        );

        if (OWNER_PHONE) {
          let notif = `🆕 *Nuevo pedido*\nCliente: ${numeroCliente}\n\n`;
          items.forEach((item) => {
            notif += `- ${item.nombre}\n`;
          });
          notif += `\nTotal: $${formatearPrecio(total)}`;
          await enviarMensaje(OWNER_PHONE, notif);
        }

        sesiones.delete(numeroCliente);
      } else if (texto === "no") {
        await enviarMensaje(numeroCliente, textoMenu());
        sesion.estado = "eligiendo";
      } else {
        await enviarMensaje(numeroCliente, 'Responde *"si"* para confirmar o *"no"* para volver a elegir.');
      }
      break;
    }

    default: {
      sesion.estado = "inicio";
    }
  }

  sesiones.set(numeroCliente, sesion);
});

app.listen(PORT, () => {
  console.log(`Bot corriendo en el puerto ${PORT}`);
});