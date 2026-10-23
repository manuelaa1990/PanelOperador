/* ============================================================================
   PANEL DE SUPERVISIÓN · LÓGICA
   ----------------------------------------------------------------------------
   - Lee la última lectura y las últimas 2 horas desde Supabase (PostgREST).
   - Pinta tarjetas grandes, alarmas en lenguaje sencillo y dos gráficas.
   - Reintenta sola cada 10 s; nunca necesita que el vigilante recargue.
   - Con ?demo=1 funciona sin Supabase (útil para probar la pantalla).
   - Con ?demo=1&alarma=1 muestra una alarma de ejemplo.
   ============================================================================ */

(function () {
  'use strict';

  const CFG = window.CONFIG_SUPERVISION;
  const $ = (id) => document.getElementById(id);
  const PARAMS = new URLSearchParams(window.location.search);
  const MODO_DEMO = PARAMS.get('demo') === '1';
  const DEMO_ALARMA = PARAMS.get('alarma') === '1';
  const DEMO_AVISO = PARAMS.get('aviso') === '1';

  const CANALES = Array.isArray(CFG.canales) ? CFG.canales : [];
  const CANAL_POR_ID = {};
  CANALES.forEach((c) => { CANAL_POR_ID[c.id] = c; });

  const PRINCIPALES = CANALES.filter((c) => c.principal);
  const SECUNDARIOS = CANALES.filter((c) => !c.principal);

  const VENTANA_MS = (CFG.actualizacion.ventanaHoras || 2) * 3600 * 1000;
  const AVISO_MS = CFG.frescura.avisoMs;
  const CRITICO_MS = CFG.frescura.criticoMs;
  const DIF_MARCHA = CFG.equipo.marchaDiferencialPsi;
  const REPOSO_AVISO_MS = CFG.equipo.reposoAvisoMin * 60000;
  const REPOSO_FALLA_MS = CFG.equipo.reposoFallaMin * 60000;
  const CICLOS = CFG.equipo.ciclos;

  /* ------------------------------- ESTADO --------------------------------- */

  const estado = {
    fila: null,
    historial: [],
    error: null,
    firmaAlarmas: '',
    firmaResumen: '',
    alarmas: [],
    ultimaCarga: 0
  };

  /* ------------------------------ UTILIDADES ------------------------------ */

  function aNumero(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = typeof valor === 'number' ? valor : Number(valor);
    return Number.isFinite(n) ? n : null;
  }

  function numero(valor, decimales) {
    const dec = Number.isFinite(decimales) ? decimales : 1;
    return Number(valor).toLocaleString('es-VE', {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
      useGrouping: false
    });
  }

  function textoValor(canal, valor) {
    if (!Number.isFinite(valor)) return '—';
    return numero(valor, canal.decimales) + ' ' + canal.unidad;
  }

  function escapar(texto) {
    return String(texto)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fechaDe(fila) {
    if (!fila || !fila.created_at) return null;
    const f = new Date(fila.created_at);
    return Number.isNaN(f.getTime()) ? null : f;
  }

  function edadMs() {
    const f = fechaDe(estado.fila);
    if (!f) return Infinity;
    return Math.max(0, Date.now() - f.getTime());
  }

  function hace(ms) {
    if (!Number.isFinite(ms)) return 'sin datos';
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'hace ' + s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    const h = Math.floor(m / 60);
    return 'hace ' + h + ' h ' + (m % 60) + ' min';
  }

  function duracionTexto(ms) {
    if (!Number.isFinite(ms) || ms < 60000) return 'menos de 1 min';
    const minutos = Math.floor(ms / 60000);
    if (minutos < 60) return minutos + ' min';
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return horas + ' h' + (resto ? ' ' + resto + ' min' : '');
  }

  function enZona(opciones) {
    try {
      return new Intl.DateTimeFormat('es-VE', Object.assign({ timeZone: CFG.zonaHoraria }, opciones));
    } catch (e) {
      return new Intl.DateTimeFormat('es-VE', opciones);
    }
  }

  const FMT_HORA = enZona({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const FMT_HORA_CORTA = enZona({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const FMT_FECHA = enZona({ weekday: 'long', day: 'numeric', month: 'long' });

  function horaDe(fecha) {
    if (!fecha) return '—';
    return FMT_HORA.format(fecha);
  }

  function capitalizar(texto) {
    return texto.charAt(0).toUpperCase() + texto.slice(1);
  }

  /* ---------------------- CLASIFICACIÓN DE CADA CANAL ---------------------- */

  function clasificarCanal(canal, valor) {
    if (!Number.isFinite(valor)) {
      return { nivel: 'neutro', etiqueta: 'Sin dato' };
    }
    if (canal.max != null && valor >= canal.max) {
      return { nivel: 'critico', etiqueta: 'Alto' };
    }
    if (canal.min != null && valor <= canal.min) {
      return { nivel: 'critico', etiqueta: 'Bajo' };
    }
    if (canal.aviso != null && valor >= canal.aviso) {
      return { nivel: 'aviso', etiqueta: 'Precaución' };
    }
    if (canal.avisoMin != null && valor <= canal.avisoMin) {
      return { nivel: 'aviso', etiqueta: 'Precaución' };
    }
    return { nivel: 'ok', etiqueta: 'Normal' };
  }

  /* ------------------------------ ALARMAS --------------------------------- */

  function evaluarAlarmas() {
    const lista = [];
    const edad = edadMs();

    if (estado.error) {
      lista.push({
        nivel: 'aviso',
        titulo: esErrorDeRed(estado.error) ? 'Problema de conexión' : 'No se pueden leer los datos',
        detalle: estado.error,
        accion: esErrorDeRed(estado.error)
          ? 'El panel reintenta solo. Si continúa, revise la red del monitor.'
          : 'Revise la configuración de Supabase: clave, tabla y permisos de lectura.'
      });
    }

    if (!estado.fila) return lista;

    if (edad > CRITICO_MS) {
      lista.push({
        nivel: 'critico',
        titulo: 'El equipo dejó de enviar datos',
        detalle: 'La última lectura llegó ' + hace(edad) + '.',
        accion: 'Verifique que el equipo tenga energía y WiFi. Avisar al técnico.'
      });
      return lista;
    }

    if (edad > AVISO_MS) {
      lista.push({
        nivel: 'aviso',
        titulo: 'Lecturas atrasadas',
        detalle: 'La última lectura llegó ' + hace(edad) + '.',
        accion: 'Espere unos segundos. Si sigue así, avise al técnico.'
      });
    }

    CANALES.forEach((canal) => {
      const valor = estado.fila[canal.id];

      if (!Number.isFinite(valor)) {
        lista.push({
          nivel: 'aviso',
          titulo: 'Sin dato: ' + canal.nombre.toLowerCase(),
          detalle: 'El sensor no está entregando una lectura válida.',
          accion: 'Avisar al técnico de guardia.'
        });
        return;
      }

      if (canal.max != null && valor >= canal.max) {
        lista.push({
          nivel: 'critico',
          titulo: canal.nombre + ' alta',
          detalle: textoValor(canal, valor) + ' · límite ' +
            numero(canal.max, canal.decimales) + ' ' + canal.unidad,
          accion: canal.accion || 'Avisar al técnico de guardia.'
        });
      } else if (canal.min != null && valor <= canal.min) {
        lista.push({
          nivel: 'critico',
          titulo: canal.nombre + ' baja',
          detalle: textoValor(canal, valor) + ' · mínimo ' +
            numero(canal.min, canal.decimales) + ' ' + canal.unidad,
          accion: canal.accion || 'Avisar al técnico de guardia.'
        });
      } else if (canal.aviso != null && valor >= canal.aviso) {
        lista.push({
          nivel: 'aviso',
          titulo: canal.nombre + ' cerca del límite',
          detalle: textoValor(canal, valor) + ' · límite ' +
            numero(canal.max, canal.decimales) + ' ' + canal.unidad,
          accion: 'Vigilar la lectura. Si sigue subiendo, avise al técnico.'
        });
      } else if (canal.avisoMin != null && valor <= canal.avisoMin) {
        lista.push({
          nivel: 'aviso',
          titulo: canal.nombre + ' cerca del mínimo',
          detalle: textoValor(canal, valor) + ' · mínimo ' +
            numero(canal.min, canal.decimales) + ' ' + canal.unidad,
          accion: 'Vigilar la lectura. Si sigue bajando, avise al técnico.'
        });
      }
    });

    lista.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'critico' ? -1 : 1));
    return lista;
  }

  /* --------------------------- ESTADO DEL BANNER -------------------------- */

  function estadoBanner() {
    const edad = edadMs();

    if (!estado.fila) {
      if (estado.error) {
        return {
          clase: 'critico',
          icono: '×',
          titulo: esErrorDeRed(estado.error) ? 'Sin conexión' : 'Sin datos',
          detalle: estado.error
        };
      }
      return {
        clase: 'neutro', icono: '…', titulo: 'Conectando',
        detalle: 'Esperando la primera lectura del equipo.'
      };
    }

    if (edad > CRITICO_MS) {
      return {
        clase: 'critico', icono: '!', titulo: 'Sin señal del equipo',
        detalle: 'La última lectura llegó ' + hace(edad) + '. Revise energía y WiFi del equipo.'
      };
    }

    const criticas = estado.alarmas.filter((a) => a.nivel === 'critico');
    if (criticas.length) {
      const extra = criticas.length > 1 ? ' (+' + (criticas.length - 1) + ' más)' : '';
      return {
        clase: 'critico', icono: '!', titulo: 'Alarma activa',
        detalle: criticas[0].titulo + ': ' + criticas[0].detalle + extra
      };
    }

    if (estado.error) {
      return {
        clase: 'aviso', icono: '!', titulo: 'Reconectando',
        detalle: 'Se perdió la conexión un momento; el panel reintenta automáticamente.'
      };
    }

    if (edad > AVISO_MS) {
      return {
        clase: 'aviso', icono: '!', titulo: 'Lecturas atrasadas',
        detalle: 'La última lectura llegó ' + hace(edad) + '. Espere unos segundos.'
      };
    }

    const avisos = estado.alarmas.filter((a) => a.nivel === 'aviso');
    if (avisos.length) {
      const extra = avisos.length > 1 ? ' (+' + (avisos.length - 1) + ' más)' : '';
      return {
        clase: 'aviso', icono: '!', titulo: 'Requiere atención',
        detalle: avisos[0].titulo + ': ' + avisos[0].detalle + extra
      };
    }

    const equipo = calcularEquipo();
    if (equipo.detenido) {
      return {
        clase: 'neutro', icono: 'II', titulo: 'Equipo en reposo',
        detalle: 'Las presiones están igualadas: el equipo no está comprimiendo en este momento.'
      };
    }

    return {
      clase: 'ok', icono: '✓', titulo: 'Sistema en orden',
      detalle: 'Todas las lecturas están dentro de los límites configurados.'
    };
  }

  /* ---------------------------- EQUIPO / SEÑAL ---------------------------- */

  function calcularEquipo() {
    if (!estado.fila) return { estado: 'desconocido', detenido: false };
    const baja = estado.fila.presion_baja;
    const alta = estado.fila.presion_alta;
    if (!Number.isFinite(baja) || !Number.isFinite(alta)) {
      return { estado: 'desconocido', detenido: false };
    }
    const diferencial = alta - baja;
    return {
      estado: diferencial >= DIF_MARCHA ? 'marcha' : 'detenido',
      detenido: diferencial < DIF_MARCHA
    };
  }

  function clasificarSenal(rssi) {
    if (!Number.isFinite(rssi)) return { nivel: 'neutro', texto: 'Sin dato', barras: 0 };
    if (rssi >= CFG.senal.buena) return { nivel: 'ok', texto: 'Buena', barras: 4 };
    if (rssi >= CFG.senal.regular) return { nivel: 'aviso', texto: 'Regular', barras: 3 };
    if (rssi >= CFG.senal.debil) return { nivel: 'aviso', texto: 'Débil', barras: 2 };
    return { nivel: 'critico', texto: 'Muy débil', barras: 1 };
  }

  /* ------------------------------- DATOS ---------------------------------- */

  function limpiarFila(fila) {
    if (!fila) return null;
    const limpia = {
      created_at: fila.created_at || null,
      rssi: aNumero(fila.rssi),
      wifi: typeof fila.wifi === 'string' ? fila.wifi : null,
      ip: typeof fila.ip === 'string' ? fila.ip : null
    };
    CANALES.forEach((canal) => { limpia[canal.id] = aNumero(fila[canal.id]); });
    return limpia;
  }

  function mensajeError(error) {
    const texto = String((error && error.message) || error || '');
    if (error && error.name === 'AbortError') return 'El servidor tardó demasiado en responder.';
    if (/Falta configurar/.test(texto)) return texto;
    if (/no tiene lecturas/.test(texto)) return 'La tabla todavía no tiene lecturas.';
    if (/HTTP 401|HTTP 403/.test(texto)) return 'La clave de acceso a los datos fue rechazada.';
    if (/HTTP 404/.test(texto)) return 'La tabla de datos no existe o no está disponible.';
    if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(texto)) {
      return 'No hay conexión con el servidor de datos.';
    }
    return 'No se pudieron leer los datos.';
  }

  function esErrorDeRed(texto) {
    return /conexión|conexion|tardó|tardo|Failed to fetch|NetworkError|Load failed/i.test(String(texto || ''));
  }

  async function pedirSupabase(consulta) {
    const sb = CFG.supabase;
    if (!sb.clave || String(sb.clave).length < 20) {
      throw new Error('Falta configurar la clave pública de Supabase en js/config.js.');
    }

    const url = sb.url.replace(/\/$/, '') + '/rest/v1/' + sb.tabla + '?' + consulta;
    const control = new AbortController();
    const limite = setTimeout(() => control.abort(), 8000);

    try {
      const respuesta = await fetch(url, {
        headers: {
          apikey: sb.clave,
          Authorization: 'Bearer ' + sb.clave,
          Accept: 'application/json'
        },
        cache: 'no-store',
        signal: control.signal
      });
      if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
      const datos = await respuesta.json();
      return Array.isArray(datos) ? datos : [];
    } finally {
      clearTimeout(limite);
    }
  }

  /* --------------------------- FUENTE DE DEMO ----------------------------- */

  const demo = (function () {
    const t0 = Date.now() - VENTANA_MS;
    const filas = [];
    let ultimoPaso = Date.now();

    function ruido(escala) {
      return (Math.random() - 0.5) * (escala || 0.4);
    }

    function filaDemo(fecha) {
      const minutos = (fecha - t0) / 60000;
      const reciente = (Date.now() - fecha) < 150000;
      const recargo = DEMO_ALARMA && reciente ? 45 : (DEMO_AVISO && reciente ? 22 : 0);
      return {
        created_at: new Date(fecha).toISOString(),
        presion_baja: Number((41 + Math.sin(minutos / 18) * 4 + ruido(0.8)).toFixed(2)),
        presion_alta: Number((242 + Math.sin(minutos / 14) * 12 + ruido(2)).toFixed(2)),
        temp1: Number((7.8 + Math.sin(minutos / 18) * 1.6 + ruido(0.3)).toFixed(2)),
        temp2: Number((1.5 + Math.sin(minutos / 16) * 0.9 + ruido(0.2)).toFixed(2)),
        temp3: Number((72 + Math.sin(minutos / 11) * 5 + recargo + ruido(0.7)).toFixed(2)),
        temp4: Number((36 + Math.sin(minutos / 20) * 2 + ruido(0.4)).toFixed(2)),
        temp5: Number((28.5 + Math.sin(minutos / 30) * 3 + ruido(0.5)).toFixed(2)),
        wifi: 'DEMO',
        ip: '192.168.1.50',
        rssi: -58 - Math.round(Math.random() * 6)
      };
    }

    for (let t = t0; t <= Date.now(); t += 15000) filas.push(filaDemo(t));

    function avanzar() {
      const ahora = Date.now();
      if (ahora - ultimoPaso < 8000) return;
      ultimoPaso = ahora;
      filas.push(filaDemo(ahora));
      const corte = ahora - VENTANA_MS;
      while (filas.length && new Date(filas[0].created_at).getTime() < corte) filas.shift();
    }

    return {
      ultima: async function () {
        avanzar();
        return [filas[filas.length - 1]];
      },
      historial: async function () {
        avanzar();
        return filas.slice();
      }
    };
  })();

  const fuente = MODO_DEMO ? demo : {
    ultima: function () {
      return pedirSupabase('select=*&order=created_at.desc&limit=1');
    },
    historial: function () {
      const desde = new Date(Date.now() - VENTANA_MS).toISOString();
      return pedirSupabase(
        'select=created_at,presion_baja,presion_alta,temp1,temp2,temp3,temp4,temp5,rssi,wifi,ip' +
        '&created_at=gte.' + encodeURIComponent(desde) +
        '&order=created_at.asc&limit=2000'
      );
    }
  };

  /* ------------------------------ CARGA ----------------------------------- */

  async function cargarUltima() {
    try {
      const filas = await fuente.ultima();
      const fila = limpiarFila(filas[0]);
      if (!fila || !fila.created_at) throw new Error('La tabla no tiene lecturas todavía.');

      estado.fila = fila;
      estado.error = null;
      estado.ultimaCarga = Date.now();

      if (!estado.historial.length) {
        estado.historial = [fila];
      } else {
        const ultimaHistorial = estado.historial[estado.historial.length - 1];
        if (!ultimaHistorial ||
            new Date(fila.created_at).getTime() > new Date(ultimaHistorial.created_at).getTime()) {
          estado.historial.push(fila);
          if (estado.historial.length > 2200) estado.historial.shift();
        }
      }

      pintarValores();
      pintarEquipo();
      pintarGraficas();
      tick();
    } catch (error) {
      estado.error = mensajeError(error);
      tick();
    }
  }

  async function cargarHistorial() {
    try {
      const filas = await fuente.historial();
      const limpias = filas.map(limpiarFila).filter((f) => f && f.created_at);
      if (limpias.length) {
        estado.historial = limpias;
        if (estado.fila) {
          const ultima = limpias[limpias.length - 1];
          if (new Date(estado.fila.created_at).getTime() > new Date(ultima.created_at).getTime()) {
            estado.historial.push(estado.fila);
          }
        }
        pintarGraficas();
        pintarValores();
      }
    } catch (error) {
      // La gráfica conserva lo último que tenía; la cabecera ya avisa del fallo.
      console.warn('No se pudo refrescar el historial:', error);
    }
  }

  /* ----------------------------- RENDERIZADO ------------------------------ */

  let tarjetas = {};

  function crearTarjetas() {
    const contenedor = $('kpis');
    contenedor.innerHTML = '';
    tarjetas = {};

    PRINCIPALES.forEach((canal) => {
      const articulo = document.createElement('article');
      articulo.className = 'kpi';
      articulo.dataset.kpi = canal.id;
      articulo.style.setProperty('--color', canal.color);
      articulo.innerHTML =
        '<div class="kpi-cabecera">' +
          '<span class="kpi-nombre">' + escapar(canal.nombre) + '</span>' +
          '<span class="kpi-estado neutro" data-estado>Sin dato</span>' +
        '</div>' +
        '<div class="kpi-valor">' +
          '<strong data-valor>—</strong>' +
          '<span class="unidad">' + escapar(canal.unidad) + '</span>' +
        '</div>' +
        '<div class="kpi-rango" data-rango>' +
          '<span>Mín. 2 h <b>—</b></span>' +
          '<span>Máx. 2 h <b>—</b></span>' +
        '</div>' +
        '<div class="kpi-pie">' +
          '<span class="kpi-limite">' + textoLimite(canal) + '</span>' +
          '<canvas class="sparkline" aria-hidden="true"></canvas>' +
        '</div>';

      contenedor.appendChild(articulo);
      tarjetas[canal.id] = {
        articulo: articulo,
        valor: articulo.querySelector('[data-valor]'),
        estado: articulo.querySelector('[data-estado]'),
        rango: articulo.querySelector('[data-rango]'),
        lienzo: articulo.querySelector('canvas')
      };
    });
  }

  function textoLimite(canal) {
    if (canal.max != null) {
      return 'Límite ' + numero(canal.max, canal.decimales) + ' ' + canal.unidad;
    }
    if (canal.min != null) {
      return 'Mínimo ' + numero(canal.min, canal.decimales) + ' ' + canal.unidad;
    }
    return 'Sin límite';
  }

  function pintarValores() {
    PRINCIPALES.forEach((canal) => {
      const ref = tarjetas[canal.id];
      if (!ref) return;
      const valor = estado.fila ? estado.fila[canal.id] : null;
      const clasificacion = clasificarCanal(canal, valor);

      ref.valor.textContent = Number.isFinite(valor) ? numero(valor, canal.decimales) : '—';
      ref.estado.textContent = clasificacion.etiqueta;
      ref.estado.className = 'kpi-estado ' + clasificacion.nivel;

      ref.articulo.classList.remove('aviso', 'critico');
      if (clasificacion.nivel === 'aviso') ref.articulo.classList.add('aviso');
      if (clasificacion.nivel === 'critico') ref.articulo.classList.add('critico');

      let minimo = null;
      let maximo = null;
      estado.historial.forEach((fila) => {
        const v = fila[canal.id];
        if (!Number.isFinite(v)) return;
        if (minimo === null || v < minimo) minimo = v;
        if (maximo === null || v > maximo) maximo = v;
      });
      const valores = ref.rango.querySelectorAll('b');
      valores[0].textContent = Number.isFinite(minimo) ? numero(minimo, canal.decimales) : '—';
      valores[1].textContent = Number.isFinite(maximo) ? numero(maximo, canal.decimales) : '—';

      dibujarSparkline(ref.lienzo, canal);
    });
  }

  function calcularResumen() {
    if (!estado.historial.length) return null;

    let maxTemp = null;
    let maxPresion = null;
    let validas = 0;
    let enRango = 0;

    estado.historial.forEach((fila) => {
      if (Number.isFinite(fila.temp3)) {
        if (maxTemp === null || fila.temp3 > maxTemp) maxTemp = fila.temp3;
      }
      if (Number.isFinite(fila.presion_alta)) {
        if (maxPresion === null || fila.presion_alta > maxPresion) maxPresion = fila.presion_alta;
      }

      const valores = PRINCIPALES.map((canal) => fila[canal.id]);
      if (valores.every((v) => Number.isFinite(v))) {
        validas++;
        const todasOk = PRINCIPALES.every((canal) => clasificarCanal(canal, fila[canal.id]).nivel === 'ok');
        if (todasOk) enRango++;
      }
    });

    return {
      maxTemp: maxTemp,
      maxPresion: maxPresion,
      enRango: validas ? Math.round((enRango / validas) * 100) : null
    };
  }

  function pintarAlarmas() {
    const contenedor = $('listaAlarmas');
    const contador = $('contadorAlarmas');
    const alarmas = estado.alarmas;

    contador.textContent = String(alarmas.length);
    contador.classList.toggle('activo', alarmas.length > 0);

    if (!alarmas.length) {
      const resumen = calcularResumen();
      const filasResumen = resumen
        ? '<div class="resumen-vacio">' +
            '<div><span>Máx. T. descarga</span><b>' +
              (Number.isFinite(resumen.maxTemp) ? numero(resumen.maxTemp, 1) + ' °C' : '—') +
            '</b></div>' +
            '<div><span>Máx. P. descarga</span><b>' +
              (Number.isFinite(resumen.maxPresion) ? numero(resumen.maxPresion, 1) + ' PSI' : '—') +
            '</b></div>' +
            '<div><span>Tiempo en rango</span><b>' +
              (Number.isFinite(resumen.enRango) ? resumen.enRango + ' %' : '—') +
            '</b></div>' +
          '</div>'
        : '';

      contenedor.innerHTML =
        '<div class="sin-alarmas">' +
          '<div class="icono">✓</div>' +
          '<strong>Sin alarmas activas</strong>' +
          '<span>Todos los valores están dentro de los límites configurados.</span>' +
          filasResumen +
        '</div>';
      return;
    }

    contenedor.innerHTML = alarmas.map((alarma) =>
      '<article class="alarma ' + alarma.nivel + '">' +
        '<div class="alarma-icono" aria-hidden="true">!</div>' +
        '<div>' +
          '<h4>' + escapar(alarma.titulo) + '</h4>' +
          '<p>' + escapar(alarma.detalle) + '</p>' +
          '<span class="accion">' + escapar(alarma.accion) + '</span>' +
        '</div>' +
      '</article>'
    ).join('');
  }

  function pintarBanner() {
    const banner = $('banner');
    const estadoActual = estadoBanner();
    const edad = edadMs();
    const fecha = fechaDe(estado.fila);

    banner.className = 'banner ' + estadoActual.clase;
    $('bannerIcono').textContent = estadoActual.icono;
    $('bannerTitulo').textContent = estadoActual.titulo;
    $('bannerDetalle').textContent = estadoActual.detalle;
    $('txtEdad').textContent = estado.fila ? hace(edad) : '—';
    $('txtHoraUltima').textContent = fecha
      ? capitalizar(FMT_FECHA.format(fecha)) + ' · ' + horaDe(fecha)
      : '';
    $('pieActualizacion').textContent = estado.ultimaCarga
      ? 'Actualizado ' + horaDe(new Date(estado.ultimaCarga))
      : 'Esperando datos';
  }

  function pintarChip() {
    const chip = $('chipConexion');
    const text = $('txtConexion');
    let clase = 'neutro';
    let mensaje = 'Conectando…';

    if (estado.error && !estado.fila) {
      clase = 'critico';
      mensaje = esErrorDeRed(estado.error) ? 'Sin conexión' : 'Sin datos';
    } else if (estado.error) {
      clase = 'aviso'; mensaje = 'Reintentando…';
    } else if (estado.fila && edadMs() <= AVISO_MS) {
      clase = 'ok'; mensaje = 'Datos al día';
    } else if (estado.fila) {
      clase = 'aviso'; mensaje = 'Datos atrasados';
    }

    chip.className = 'chip-conexion ' + clase;
    text.textContent = mensaje;
  }

  function pintarEquipo() {
    const chip = $('chipEquipo');
    const info = calcularEquipo();
    const fila = estado.fila;

    if (!fila) {
      chip.className = 'chip-equipo neutro';
      chip.textContent = 'Sin datos';
    } else if (info.estado === 'marcha') {
      chip.className = 'chip-equipo ok';
      chip.textContent = 'En marcha';
    } else if (info.estado === 'detenido') {
      chip.className = 'chip-equipo neutro';
      chip.textContent = 'En reposo';
    } else {
      chip.className = 'chip-equipo neutro';
      chip.textContent = 'Sin datos';
    }

    const senal = clasificarSenal(fila ? fila.rssi : null);
    const senalTexto = $('senalTexto');
    const tieneSenal = Number.isFinite(fila && fila.rssi);
    senalTexto.textContent = tieneSenal ? senal.texto : 'Sin dato';
    senalTexto.title = tieneSenal ? 'Señal WiFi: ' + Math.round(fila.rssi) + ' dBm' : '';
    senalTexto.className = 'senal ' + senal.nivel;

    const barras = $('senalBarras');
    barras.className = 'barras' + (senal.barras ? ' n' + senal.barras : '');

    actualizarUltima();

    const lista = $('otrasLecturas');
    lista.innerHTML = SECUNDARIOS.map((canal) => {
      const valor = fila ? fila[canal.id] : null;
      const clasificacion = clasificarCanal(canal, valor);
      return '<li><span>' + escapar(canal.nombre) + '</span>' +
        '<b class="' + clasificacion.nivel + '">' +
        (Number.isFinite(valor) ? textoValor(canal, valor) : '—') +
        '</b></li>';
    }).join('');
  }

  function actualizarUltima() {
    const fila = estado.fila;
    const fecha = fechaDe(fila);
    $('equipoUltima').textContent = fecha
      ? horaDe(fecha) + ' · ' + hace(edadMs())
      : '—';
  }

  /* ------------------------------- GRÁFICAS ------------------------------- */

  function prepararLienzo(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ancho = Math.round(rect.width * dpr);
    const alto = Math.round(rect.height * dpr);
    if (canvas.width !== ancho || canvas.height !== alto) {
      canvas.width = ancho;
      canvas.height = alto;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, ancho: rect.width, alto: rect.height };
  }

  const FUENTE_GRAFICA = '11px "Segoe UI", system-ui, sans-serif';
  const FUENTE_GRANDE = '12px "Segoe UI", system-ui, sans-serif';

  function textoEje(valor, rango) {
    if (Math.abs(valor) >= 100 || rango >= 50) return String(Math.round(valor));
    return valor.toFixed(1).replace('.', ',');
  }

  function dibujarGrafica(idCanvas, def) {
    const canvas = $(idCanvas);
    if (!canvas) return;
    const lienzo = prepararLienzo(canvas);
    if (!lienzo) return;

    const ctx = lienzo.ctx;
    const ancho = lienzo.ancho;
    const alto = lienzo.alto;
    ctx.clearRect(0, 0, ancho, alto);

    const margen = { izq: 44, der: 12, arriba: 12, abajo: 22 };
    const area = {
      x: margen.izq,
      y: margen.arriba,
      w: Math.max(10, ancho - margen.izq - margen.der),
      h: Math.max(10, alto - margen.arriba - margen.abajo)
    };

    const ahora = Date.now();
    const desde = ahora - VENTANA_MS;
    const rango = def.max - def.min;

    const filas = estado.historial.filter((fila) => {
      const t = new Date(fila.created_at).getTime();
      return Number.isFinite(t) && t >= desde - 60000 && t <= ahora + 60000;
    });

    const xDe = (t) => area.x + ((t - desde) / VENTANA_MS) * area.w;
    const yDe = (v) => area.y + (1 - (v - def.min) / rango) * area.h;

    /* Rejilla y etiquetas del eje Y */
    ctx.lineWidth = 1;
    ctx.font = FUENTE_GRAFICA;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const pasos = def.pasos || 4;
    for (let i = 0; i <= pasos; i++) {
      const y = area.y + (area.h * i) / pasos;
      const valor = def.max - (rango * i) / pasos;
      ctx.beginPath();
      ctx.strokeStyle = i === pasos ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.055)';
      ctx.moveTo(area.x, y + 0.5);
      ctx.lineTo(area.x + area.w, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#7f93a8';
      ctx.fillText(textoEje(valor, rango), area.x - 8, y);
    }

    /* Etiquetas de tiempo */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const t = desde + (VENTANA_MS * i) / 4;
      const x = xDe(t);
      ctx.fillStyle = '#61778b';
      const etiqueta = FMT_HORA_CORTA.format(new Date(t));
      if (i === 0) { ctx.textAlign = 'left'; ctx.fillText(etiqueta, area.x, area.y + area.h + 7); }
      else if (i === 4) { ctx.textAlign = 'right'; ctx.fillText(etiqueta, area.x + area.w, area.y + area.h + 7); }
      else { ctx.textAlign = 'center'; ctx.fillText(etiqueta, x, area.y + area.h + 7); }
    }

    if (!filas.length) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#61778b';
      ctx.font = FUENTE_GRANDE;
      ctx.fillText('Sin datos en las últimas ' + CFG.actualizacion.ventanaHoras + ' horas', area.x + area.w / 2, area.y + area.h / 2);
      return;
    }

    /* Líneas de límite (solo si caen dentro de la escala) */
    const etiquetasLimite = [];
    def.canales.forEach((idCanal) => {
      const canal = CANAL_POR_ID[idCanal];
      if (!canal || canal.max == null) return;
      if (canal.max < def.min || canal.max > def.max) return;
      const y = yDe(canal.max);
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(255, 95, 99, .38)';
      ctx.lineWidth = 1;
      ctx.moveTo(area.x, y + 0.5);
      ctx.lineTo(area.x + area.w, y + 0.5);
      ctx.stroke();
      ctx.restore();

      etiquetasLimite.push({ y: y, texto: 'límite ' + numero(canal.max, 0) });
    });

    /* Series */
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    def.canales.forEach((idCanal) => {
      const canal = CANAL_POR_ID[idCanal];
      if (!canal) return;

      ctx.beginPath();
      ctx.strokeStyle = canal.color;
      ctx.lineWidth = 2;
      let trazando = false;
      let anteriorT = null;
      let ultimoPunto = null;

      filas.forEach((fila) => {
        const valor = fila[idCanal];
        const t = new Date(fila.created_at).getTime();
        if (!Number.isFinite(valor) || !Number.isFinite(t) || valor < def.min - rango || valor > def.max + rango) {
          trazando = false;
          anteriorT = null;
          return;
        }
        if (anteriorT !== null && t - anteriorT > 120000) trazando = false;
        const x = xDe(t);
        const y = yDe(valor);
        if (!trazando) { ctx.moveTo(x, y); trazando = true; }
        else ctx.lineTo(x, y);
        anteriorT = t;
        ultimoPunto = { x: x, y: y };
      });
      ctx.stroke();

      if (ultimoPunto) {
        ctx.beginPath();
        ctx.fillStyle = canal.color;
        ctx.globalAlpha = 0.22;
        ctx.arc(ultimoPunto.x, ultimoPunto.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.fillStyle = canal.color;
        ctx.arc(ultimoPunto.x, ultimoPunto.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    ctx.restore();

    /* Etiquetas de los límites, por encima de las series para que se lean */
    ctx.font = FUENTE_GRAFICA;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    etiquetasLimite.forEach((etiqueta) => {
      const anchoTexto = ctx.measureText(etiqueta.texto).width;
      const x = area.x + area.w - 2;
      ctx.fillStyle = 'rgba(17, 26, 34, .92)';
      ctx.fillRect(x - anchoTexto - 5, etiqueta.y - 15, anchoTexto + 7, 13);
      ctx.fillStyle = 'rgba(255, 138, 141, .85)';
      ctx.fillText(etiqueta.texto, x, etiqueta.y - 2);
    });
  }

  function dibujarSparkline(canvas, canal) {
    const lienzo = prepararLienzo(canvas);
    if (!lienzo) return;
    const ctx = lienzo.ctx;
    const ancho = lienzo.ancho;
    const alto = lienzo.alto;
    ctx.clearRect(0, 0, ancho, alto);

    const desde = Date.now() - VENTANA_MS;
    const puntos = [];
    estado.historial.forEach((fila) => {
      const t = new Date(fila.created_at).getTime();
      const v = fila[canal.id];
      if (Number.isFinite(t) && t >= desde && Number.isFinite(v)) puntos.push({ t: t, v: v });
    });

    if (puntos.length > 1) {
      let min = puntos[0].v;
      let max = puntos[0].v;
      puntos.forEach((p) => { if (p.v < min) min = p.v; if (p.v > max) max = p.v; });
      if (canal.max != null && canal.max > max) max = canal.max;
      if (max - min < 1) { max += 0.5; min -= 0.5; }
      const margen = (max - min) * 0.12;
      min -= margen;
      max += margen;

      const xDe = (t) => ((t - desde) / VENTANA_MS) * ancho;
      const yDe = (v) => alto - ((v - min) / (max - min)) * (alto - 4) - 2;

      const gradiente = ctx.createLinearGradient(0, 0, 0, alto);
      gradiente.addColorStop(0, canal.color + '38');
      gradiente.addColorStop(1, canal.color + '00');

      ctx.beginPath();
      const primero = puntos[0];
      ctx.moveTo(xDe(primero.t), alto);
      puntos.forEach((p) => ctx.lineTo(xDe(p.t), yDe(p.v)));
      ctx.lineTo(xDe(puntos[puntos.length - 1].t), alto);
      ctx.closePath();
      ctx.fillStyle = gradiente;
      ctx.fill();

      ctx.beginPath();
      puntos.forEach((p, i) => {
        const x = xDe(p.t);
        const y = yDe(p.v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = canal.color;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();

      const ultimo = puntos[puntos.length - 1];
      ctx.beginPath();
      ctx.fillStyle = canal.color;
      ctx.arc(xDe(ultimo.t), yDe(ultimo.v), 2.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, alto - 4);
      ctx.lineTo(ancho, alto - 4);
      ctx.stroke();
    }
  }

  function pintarGraficas() {
    Object.keys(CFG.graficas).forEach((clave) => {
      const def = CFG.graficas[clave];
      dibujarGrafica(def.idGrafica, def);
    });
  }

  function crearLeyendas() {
    Object.keys(CFG.graficas).forEach((clave) => {
      const def = CFG.graficas[clave];
      const contenedor = $(def.idLeyenda);
      if (!contenedor) return;
      contenedor.innerHTML = def.canales.map((idCanal) => {
        const canal = CANAL_POR_ID[idCanal];
        if (!canal) return '';
        return '<span style="--color:' + canal.color + '"><i></i>' + escapar(canal.corto) + '</span>';
      }).join('');
    });
  }

  /* ------------------------------- RELOJ ---------------------------------- */

  function pintarReloj() {
    const ahora = new Date();
    $('reloj').textContent = FMT_HORA.format(ahora);
    $('fecha').textContent = capitalizar(FMT_FECHA.format(ahora));
  }

  function tick() {
    pintarReloj();

    const alarmas = evaluarAlarmas();
    const firma = JSON.stringify(alarmas);
    const resumen = alarmas.length ? null : calcularResumen();
    const firmaResumen = JSON.stringify(resumen);

    if (firma !== estado.firmaAlarmas || firmaResumen !== estado.firmaResumen) {
      estado.alarmas = alarmas;
      estado.firmaAlarmas = firma;
      estado.firmaResumen = firmaResumen;
      pintarAlarmas();
    } else {
      estado.alarmas = alarmas;
    }

    pintarBanner();
    pintarChip();
    actualizarUltima();
  }

  /* ------------------------------- INICIO --------------------------------- */

  function aplicarIdentidad() {
    document.title = CFG.cliente + ' · ' + CFG.planta + ' · Supervisión';
    $('txtCliente').textContent = CFG.cliente;
    $('txtPlanta').textContent = CFG.planta;
    $('etiquetaDemo').hidden = !MODO_DEMO;

    const limites = PRINCIPALES
      .filter((c) => c.max != null)
      .map((c) => c.corto + ' ' + numero(c.max, c.decimales) + ' ' + c.unidad)
      .join(' · ');
    $('pieLimites').textContent = limites;

    const contacto = CFG.contacto || {};
    if (contacto.telefono) {
      $('ayudaContacto').textContent = 'Avise a ' + (contacto.nombre || 'técnico') + ': ' + contacto.telefono;
    } else if (contacto.nombre) {
      $('ayudaContacto').textContent = 'Avise al ' + contacto.nombre + '.';
    }
  }

  function conectarBotonPantalla() {
    const boton = $('btnPantalla');
    if (!document.fullscreenEnabled) {
      boton.hidden = true;
      return;
    }
    boton.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
    document.addEventListener('keydown', (evento) => {
      if ((evento.key === 'f' || evento.key === 'F') && !evento.ctrlKey && !evento.metaKey) {
        boton.click();
      }
    });
  }

  function observarTamano() {
    let pendiente = false;
    const redibujar = () => {
      if (pendiente) return;
      pendiente = true;
      window.requestAnimationFrame(() => {
        pendiente = false;
        pintarGraficas();
        PRINCIPALES.forEach((canal) => {
          const ref = tarjetas[canal.id];
          if (ref) dibujarSparkline(ref.lienzo, canal);
        });
      });
    };
    window.addEventListener('resize', redibujar);
    if (window.ResizeObserver) {
      const observador = new ResizeObserver(redibujar);
      document.querySelectorAll('canvas.grafica').forEach((c) => observador.observe(c.parentElement));
    }
  }

  async function iniciar() {
    aplicarIdentidad();
    crearTarjetas();
    crearLeyendas();
    conectarBotonPantalla();
    observarTamano();
    pintarReloj();
    tick();

    await Promise.all([cargarHistorial(), cargarUltima()]);

    setInterval(cargarUltima, CFG.actualizacion.ultimaMs);
    setInterval(cargarHistorial, CFG.actualizacion.historialMs);
    setInterval(tick, 1000);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        cargarUltima();
        cargarHistorial();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
