/* ============================================================================
   PANEL DE SUPERVISIÓN · LÓGICA
   ----------------------------------------------------------------------------
   - Lee la última lectura y las últimas 2 horas desde Supabase (PostgREST).
   - Pinta tarjetas grandes, alarmas en lenguaje sencillo e historial consultable.
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
  const PRINCIPALES = CANALES.filter((c) => c.principal);
  const TARJETAS = CANALES.filter((c) => c.principal || c.tarjeta);

  const VENTANA_MS = (CFG.actualizacion.ventanaHoras || 2) * 3600 * 1000;
  const AVISO_MS = CFG.frescura.avisoMs;
  const CRITICO_MS = CFG.frescura.criticoMs;
  const DIF_MARCHA = CFG.equipo.marchaDiferencialPsi;
  const REPOSO_AVISO_MS = CFG.equipo.reposoAvisoMin * 60000;
  const REPOSO_FALLA_MS = CFG.equipo.reposoFallaMin * 60000;
  const CICLOS = CFG.equipo.ciclos;
  const HIST = CFG.historial || { porPagina: 100, horasPorDefecto: 24, autoMs: 30000 };

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

  const tablaHistorial = {
    desde: null,
    hasta: null,
    pagina: 0,
    porPagina: Math.max(10, Number(HIST.porPagina) || 100),
    total: null,
    filas: [],
    cargando: false,
    error: null,
    errorConexion: false,
    solicitud: 0,
    firma: '',
    actualizado: null
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
  const FMT_FECHA = enZona({ weekday: 'long', day: 'numeric', month: 'long' });
  const FMT_FECHA_HORA = enZona({
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });

  function horaDe(fecha) {
    if (!fecha) return '—';
    return FMT_HORA.format(fecha);
  }

  function fechaHoraDe(fecha) {
    if (!fecha) return '—';
    return FMT_FECHA_HORA.format(fecha);
  }

  function valorParaInput(fecha) {
    const d = new Date(fecha);
    const dos = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) +
      'T' + dos(d.getHours()) + ':' + dos(d.getMinutes());
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
        detalle: 'No llegan lecturas nuevas.',
        accion: 'Revisar energía o conexión del equipo. Avisar al técnico.'
      });
      return lista;
    }

    if (edad > AVISO_MS) {
      lista.push({
        nivel: 'aviso',
        titulo: 'Lecturas atrasadas',
        detalle: 'No llegan lecturas nuevas.',
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

    if (edad <= AVISO_MS) analizarPresiones(lista);

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
        clase: 'critico', icono: '!', titulo: 'Falla · sin datos',
        detalle: 'El equipo dejó de enviar datos.',
        accion: 'Revisar energía o conexión del equipo.'
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
        detalle: 'No llegan lecturas nuevas.'
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
    if (!estado.fila || edadMs() > AVISO_MS) {
      return { estado: 'desconocido', detenido: false };
    }
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

  function esMarcha(fila) {
    if (!fila) return null;
    const alta = fila.presion_alta;
    const baja = fila.presion_baja;
    if (!Number.isFinite(alta) || !Number.isFinite(baja)) return null;
    return (alta - baja) >= DIF_MARCHA;
  }

  function analizarPresiones(lista) {
    const filas = estado.historial;
    if (!filas.length) return;

    const equipo = calcularEquipo();

    if (equipo.estado === 'detenido') {
      let inicio = null;
      let anterior = null;
      for (let i = filas.length - 1; i >= 0; i--) {
        const t = new Date(filas[i].created_at).getTime();
        if (!Number.isFinite(t)) break;
        if (anterior !== null && anterior - t > 5 * 60000) break;
        anterior = t;

        const marcha = esMarcha(filas[i]);
        if (marcha === false) {
          inicio = t;
        } else {
          break;
        }
      }

      if (inicio !== null) {
        const duracion = Date.now() - inicio;
        if (duracion >= REPOSO_FALLA_MS) {
          lista.push({
            nivel: 'critico',
            titulo: 'Equipo detenido demasiado tiempo',
            detalle: 'Las presiones llevan ' + duracionTexto(duracion) + ' igualadas.',
            accion: 'Revisar el equipo. Puede estar detenido por una falla.'
          });
        } else if (duracion >= REPOSO_AVISO_MS) {
          lista.push({
            nivel: 'aviso',
            titulo: 'Equipo detenido hace ' + duracionTexto(duracion),
            detalle: 'Las presiones están igualadas.',
            accion: 'Vigilar el equipo. Si no arranca, avise al técnico.'
          });
        }
      }
    }

    const desde = Date.now() - CICLOS.ventanaMin * 60000;
    const paradas = [];
    let inicioParada = null;
    let ultimaFecha = null;

    filas.forEach((fila) => {
      const t = new Date(fila.created_at).getTime();
      if (!Number.isFinite(t)) return;
      if (ultimaFecha !== null && t - ultimaFecha > 5 * 60000) {
        inicioParada = null;
      }
      ultimaFecha = t;

      const marcha = esMarcha(fila);
      if (marcha === null) {
        inicioParada = null;
        return;
      }

      if (!marcha && inicioParada === null) {
        inicioParada = t;
      } else if (marcha && inicioParada !== null) {
        const duracion = t - inicioParada;
        if (duracion >= CICLOS.cortoMinMin * 60000 &&
            duracion < CICLOS.cortoMaxMin * 60000) {
          paradas.push({ fin: t });
        }
        inicioParada = null;
      }
    });

    const recientes = paradas.filter((p) => p.fin >= desde);
    if (recientes.length >= CICLOS.minimo) {
      lista.push({
        nivel: 'aviso',
        titulo: 'Arranques y paradas repetidas',
        detalle: recientes.length + ' paradas cortas en la última hora.',
        accion: 'Avisar al técnico: puede ser una fuga o un presostato mal regulado.'
      });
    }
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

  async function pedirSupabase(consulta, opciones) {
    const sb = CFG.supabase;
    if (!sb.clave || String(sb.clave).length < 20) {
      throw new Error('Falta configurar la clave pública de Supabase en js/config.js.');
    }

    const url = sb.url.replace(/\/$/, '') + '/rest/v1/' + sb.tabla + '?' + consulta;
    const control = new AbortController();
    const limite = setTimeout(() => control.abort(), 12000);
    const cabeceras = {
      apikey: sb.clave,
      Authorization: 'Bearer ' + sb.clave,
      Accept: 'application/json'
    };
    if (opciones && opciones.conTotal) cabeceras.Prefer = 'count=exact';

    try {
      const respuesta = await fetch(url, {
        headers: cabeceras,
        cache: 'no-store',
        signal: control.signal
      });
      if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
      const datos = await respuesta.json();
      const filas = Array.isArray(datos) ? datos : [];

      if (opciones && opciones.conTotal) {
        const contentRange = respuesta.headers.get('content-range') || '';
        const total = Number(contentRange.split('/')[1]);
        return { filas: filas, total: Number.isFinite(total) ? total : null };
      }
      return filas;
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
      },
      rango: function (desde, hasta) {
        const inicio = desde.getTime();
        const fin = hasta.getTime();
        const maximo = 2000;
        const paso = Math.max(15000, Math.ceil((fin - inicio) / maximo));
        const resultado = [];
        for (let t = fin; t >= inicio && resultado.length < maximo; t -= paso) {
          resultado.push(filaDemo(t));
        }
        return resultado;
      },
      historialRango: async function (desde, hasta, offset, limite) {
        const todas = this.rango(desde, hasta);
        return {
          filas: todas.slice(offset, offset + limite),
          total: todas.length
        };
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
    },
    historialRango: function (desde, hasta, offset, limite) {
      return pedirSupabase(
        'select=created_at,presion_baja,presion_alta,temp1,temp2,temp3,temp4,temp5,rssi,wifi,ip' +
        '&created_at=gte.' + encodeURIComponent(desde.toISOString()) +
        '&created_at=lte.' + encodeURIComponent(hasta.toISOString()) +
        '&order=created_at.desc&limit=' + limite + '&offset=' + offset,
        { conTotal: true }
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
        pintarValores();
      }
    } catch (error) {
      // Las tarjetas conservan lo último que tenían; la cabecera avisa del fallo.
      console.warn('No se pudo refrescar el historial:', error);
    }
  }

  /* ----------------------------- RENDERIZADO ------------------------------ */

  let tarjetas = {};

  function crearTarjetas() {
    const contenedor = $('kpis');
    contenedor.innerHTML = '';
    tarjetas = {};

    TARJETAS.forEach((canal) => {
      const articulo = document.createElement('article');
      articulo.className = 'kpi' + (canal.compacta ? ' compacta' : '');
      articulo.dataset.kpi = canal.id;
      articulo.style.setProperty('--color', canal.color);
      const pieEtiqueta = (canal.max != null || canal.min != null)
        ? textoLimite(canal)
        : 'Tendencia 2 h';
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
          '<span class="kpi-limite">' + escapar(pieEtiqueta) + '</span>' +
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
    TARJETAS.forEach((canal) => {
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

    marcarTarjetasObsoletas();
  }

  function marcarTarjetasObsoletas() {
    const obsoleto = !estado.fila || edadMs() > AVISO_MS;
    TARJETAS.forEach((canal) => {
      const ref = tarjetas[canal.id];
      if (!ref) return;
      ref.articulo.classList.toggle('obsoleto', obsoleto);
      if (obsoleto) {
        ref.estado.textContent = 'Sin dato';
        ref.estado.className = 'kpi-estado neutro';
      }
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
    const accion = $('bannerAccion');
    if (estadoActual.accion) {
      accion.textContent = estadoActual.accion;
      accion.hidden = false;
    } else {
      accion.hidden = true;
      accion.textContent = '';
    }
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
    const senalTexto = $('senalTexto');
    const barras = $('senalBarras');
    const fila = estado.fila;
    const edad = edadMs();
    let clase = 'neutro';
    let mensaje = 'Conectando';
    let detalle = 'Esperando la primera lectura del equipo.';

    if (estado.error) {
      clase = 'critico';
      mensaje = 'Error';
      detalle = estado.error;
    } else if (!fila) {
      clase = 'neutro';
      mensaje = 'Conectando';
    } else if (edad <= AVISO_MS) {
      clase = 'ok';
      mensaje = 'Conectado';
      detalle = 'El equipo está enviando datos.';
    } else if (edad <= CRITICO_MS) {
      clase = 'aviso';
      mensaje = 'Falla';
      detalle = 'Lecturas atrasadas.';
    } else {
      clase = 'critico';
      mensaje = 'Falla';
      detalle = 'Falla: sin datos del equipo.';
    }

    chip.className = 'chip-conexion ' + clase;
    chip.title = detalle;
    text.textContent = mensaje;

    const tieneSenal = Boolean(fila) && edad <= AVISO_MS && Number.isFinite(fila.rssi);
    const senal = clasificarSenal(tieneSenal ? fila.rssi : null);
    senalTexto.textContent = tieneSenal ? senal.texto : 'Sin dato';
    senalTexto.title = tieneSenal ? 'Señal: ' + Math.round(fila.rssi) + ' dBm' : 'Sin dato de señal';
    senalTexto.className = 'senal ' + (tieneSenal ? senal.nivel : 'neutro');
    barras.className = 'barras' + (tieneSenal && senal.barras ? ' n' + senal.barras : '');
  }

  /* ------------------------------- HISTORIAL ------------------------------ */

  function crearCabeceraHistorial() {
    $('historialCabecera').innerHTML =
      '<tr><th>Fecha y hora</th><th>Equipo</th>' +
      CANALES.map((canal) =>
        '<th>' + escapar(canal.corto) +
        '<small>' + escapar(canal.unidad) + '</small></th>'
      ).join('') +
      '</tr>';
  }

  function estadoDeFila(fila) {
    const alta = fila.presion_alta;
    const baja = fila.presion_baja;
    if (!Number.isFinite(alta) || !Number.isFinite(baja)) {
      return { texto: 'Sin dato', clase: 'neutro' };
    }
    return (alta - baja) >= DIF_MARCHA
      ? { texto: 'Marcha', clase: 'marcha' }
      : { texto: 'Reposo', clase: 'reposo' };
  }

  function pintarTablaHistorial() {
    const cuerpo = $('historialCuerpo');
    const columnas = CANALES.length + 2;

    if (!tablaHistorial.filas.length) {
      if (tablaHistorial.error) {
        cuerpo.innerHTML = '<tr><td class="tabla-vacia" colspan="' + columnas + '">' +
          '<div class="vacio-titulo">No se pudo cargar el historial</div>' +
          '<div class="vacio-texto">' + escapar(tablaHistorial.error) + '</div>' +
          '<button type="button" class="btn-vacio" data-reintentar="1">Reintentar</button>' +
          '</td></tr>';
        return;
      }

      const ultima = estado.fila ? fechaHoraDe(fechaDe(estado.fila)) : null;
      const detalle = ultima
        ? 'La última lectura fue ' + ultima + ' (' + hace(edadMs()) + ').'
        : 'Todavía no hay lecturas registradas.';
      cuerpo.innerHTML = '<tr><td class="tabla-vacia" colspan="' + columnas + '">' +
        '<div class="vacio-titulo">No hay lecturas en este rango</div>' +
        '<div class="vacio-texto">' + escapar(detalle) + '</div>' +
        '<button type="button" class="btn-vacio" data-ir-rango="24">Ver últimas 24 h</button>' +
        '</td></tr>';
      return;
    }

    cuerpo.innerHTML = tablaHistorial.filas.map((fila) => {
      const fecha = fechaDe(fila);
      const equipo = estadoDeFila(fila);
      const celdas = CANALES.map((canal) => {
        const valor = fila[canal.id];
        const clasificacion = clasificarCanal(canal, valor);
        return '<td class="valor ' + clasificacion.nivel + '">' +
          (Number.isFinite(valor) ? numero(valor, canal.decimales) : '—') +
          '</td>';
      }).join('');

      return '<tr>' +
        '<td class="fecha">' + escapar(fechaHoraDe(fecha)) + '</td>' +
        '<td><span class="estado-fila ' + equipo.clase + '">' + equipo.texto + '</span></td>' +
        celdas +
        '</tr>';
    }).join('');
  }

  function rangoEnVivo() {
    if (!tablaHistorial.hasta) return false;
    return Math.abs(Date.now() - tablaHistorial.hasta.getTime()) <= 2 * 60000;
  }

  function actualizarModoHistorial() {
    const modo = $('historialModo');
    if (!modo) return;

    if (tablaHistorial.errorConexion) {
      modo.textContent = 'Sin conexión';
      modo.classList.remove('vivo');
      modo.title = 'No se pudo consultar Supabase. Se reintentará automáticamente.';
      return;
    }

    const vivo = rangoEnVivo() && tablaHistorial.pagina === 0 && !tablaHistorial.error;
    modo.textContent = vivo ? 'En vivo' : 'Histórico';
    modo.classList.toggle('vivo', vivo);
    modo.title = vivo
      ? 'Actualización automática cada ' + Math.round((HIST.autoMs || 30000) / 1000) + ' s'
      : 'Rango histórico: use 24 h o vuelva a consultar para regresar al presente';
  }

  function actualizarInfoHistorial(mensaje) {
    const info = $('historialInfo');
    const rangoInfo = $('tablaRangoInfo');
    const actualizado = $('tablaActualizado');

    if (mensaje) {
      info.textContent = mensaje;
      rangoInfo.textContent = '—';
      actualizado.textContent = '—';
      const modo = $('historialModo');
      if (modo) {
        modo.textContent = 'Consultando';
        modo.classList.remove('vivo');
      }
      return;
    }

    actualizarModoHistorial();

    if (tablaHistorial.error) {
      const accion = tablaHistorial.filas.length ? 'actualizar' : 'cargar';
      info.textContent = 'No se pudo ' + accion + ': ' + tablaHistorial.error +
        (tablaHistorial.filas.length ? ' · se muestran los últimos datos.' : '');
      rangoInfo.textContent = tablaHistorial.filas.length ? 'Datos anteriores' : '—';
      actualizado.textContent = (tablaHistorial.filas.length && tablaHistorial.actualizado)
        ? 'Actualizado ' + horaDe(tablaHistorial.actualizado)
        : '—';
      return;
    }

    if (!tablaHistorial.desde || !tablaHistorial.hasta) {
      info.textContent = 'Seleccione un rango y pulse Consultar.';
      rangoInfo.textContent = '—';
      actualizado.textContent = '—';
      return;
    }

    const desde = fechaHoraDe(tablaHistorial.desde);
    const hasta = fechaHoraDe(tablaHistorial.hasta);

    if (!tablaHistorial.filas.length) {
      info.textContent = 'Sin lecturas entre ' + desde + ' y ' + hasta + '.';
      rangoInfo.textContent = '0 lecturas';
      actualizado.textContent = 'Consultado ' + horaDe(new Date());
      return;
    }

    const total = tablaHistorial.total;
    const inicio = tablaHistorial.pagina * tablaHistorial.porPagina + 1;
    const fin = inicio + tablaHistorial.filas.length - 1;

    info.textContent = (total != null ? total.toLocaleString('es-VE') : String(tablaHistorial.filas.length)) +
      ' lecturas · ' + desde + ' → ' + hasta;

    rangoInfo.textContent = total != null
      ? 'Mostrando ' + inicio + '–' + fin + ' de ' + total.toLocaleString('es-VE')
      : 'Mostrando ' + tablaHistorial.filas.length + ' lecturas';

    actualizado.textContent = 'Actualizado ' + horaDe(tablaHistorial.actualizado || new Date());
  }

  function actualizarPaginacion() {
    const total = tablaHistorial.total;
    const paginas = total != null ? Math.max(1, Math.ceil(total / tablaHistorial.porPagina)) : 1;
    $('paginaActual').textContent = 'Página ' + (tablaHistorial.pagina + 1) + ' de ' + paginas;
    $('btnPaginaAnterior').disabled = tablaHistorial.cargando || tablaHistorial.pagina <= 0;
    $('btnPaginaSiguiente').disabled = tablaHistorial.cargando || total == null ||
      (tablaHistorial.pagina + 1) >= paginas;
  }

  async function cargarTablaHistorial(pagina, usarRangoAplicado, silencioso) {
    const paginaSolicitada = Math.max(0, Number(pagina) || 0);
    let desde;
    let hasta;

    if (usarRangoAplicado && tablaHistorial.desde && tablaHistorial.hasta) {
      desde = new Date(tablaHistorial.desde);
      hasta = new Date(tablaHistorial.hasta);
    } else {
      const desdeValor = $('histDesde').value;
      const hastaValor = $('histHasta').value;
      desde = desdeValor ? new Date(desdeValor) : null;
      hasta = hastaValor ? new Date(hastaValor) : null;

      if (!desde || Number.isNaN(desde.getTime()) || !hasta || Number.isNaN(hasta.getTime())) {
        tablaHistorial.error = 'Indique una fecha y hora válidas.';
        tablaHistorial.errorConexion = false;
        tablaHistorial.filas = [];
        tablaHistorial.total = null;
        tablaHistorial.firma = '';
        pintarTablaHistorial();
        actualizarInfoHistorial();
        actualizarPaginacion();
        return;
      }

      // Si el rango termina ahora, incluimos también los segundos transcurridos.
      if (Math.abs(Date.now() - hasta.getTime()) < 120000) hasta = new Date();
    }

    if (desde >= hasta) {
      tablaHistorial.error = 'La fecha "Desde" debe ser anterior a "Hasta".';
      tablaHistorial.errorConexion = false;
      tablaHistorial.filas = [];
      tablaHistorial.total = null;
      tablaHistorial.firma = '';
      pintarTablaHistorial();
      actualizarInfoHistorial();
      actualizarPaginacion();
      return;
    }

    const solicitud = ++tablaHistorial.solicitud;
    tablaHistorial.cargando = true;
    tablaHistorial.error = null;
    tablaHistorial.errorConexion = false;
    if (!silencioso) $('btnConsultar').disabled = true;
    if (!silencioso) actualizarInfoHistorial('Consultando lecturas…');
    actualizarPaginacion();

    try {
      const offset = paginaSolicitada * tablaHistorial.porPagina;
      const resultado = await fuente.historialRango(
        desde, hasta, offset, tablaHistorial.porPagina
      );
      if (solicitud !== tablaHistorial.solicitud) return;

      const filas = (resultado.filas || [])
        .map(limpiarFila)
        .filter((fila) => fila && fila.created_at);
      const total = Number.isFinite(resultado.total) ? resultado.total : null;
      const firma = (total != null ? total : '') + '|' +
        filas.map((fila) => fila.created_at).join('|');

      tablaHistorial.desde = desde;
      tablaHistorial.hasta = hasta;
      tablaHistorial.pagina = paginaSolicitada;
      tablaHistorial.total = total;
      tablaHistorial.filas = filas;
      tablaHistorial.actualizado = new Date();

      if (!silencioso || firma !== tablaHistorial.firma) {
        pintarTablaHistorial();
      }
      tablaHistorial.firma = firma;
      actualizarInfoHistorial();
    } catch (error) {
      if (solicitud !== tablaHistorial.solicitud) return;
      tablaHistorial.error = mensajeError(error);
      tablaHistorial.errorConexion = true;

      if (!silencioso) {
        tablaHistorial.filas = [];
        tablaHistorial.total = null;
        tablaHistorial.firma = '';
      }
      if (!silencioso || !tablaHistorial.filas.length) pintarTablaHistorial();
      actualizarInfoHistorial();
    } finally {
      if (solicitud === tablaHistorial.solicitud) {
        tablaHistorial.cargando = false;
        $('btnConsultar').disabled = false;
        actualizarPaginacion();
        actualizarModoHistorial();
      }
    }
  }

  function marcarRangoActivo(boton) {
    document.querySelectorAll('.btn-rango').forEach((b) => {
      b.classList.toggle('activo', b === boton);
    });
  }

  function puedeAutoRefrescar() {
    if (document.hidden || tablaHistorial.cargando) return false;
    if (tablaHistorial.pagina !== 0) return false;
    if (!rangoEnVivo()) return false;
    const caja = document.querySelector('.tabla-caja');
    return !caja || caja.scrollTop < 24;
  }

  async function refrescarHistorialEnVivo() {
    if (!tablaHistorial.desde || !tablaHistorial.hasta) return;

    const duracion = Math.max(
      60000,
      tablaHistorial.hasta.getTime() - tablaHistorial.desde.getTime()
    );
    const fin = new Date();
    const inicio = new Date(fin.getTime() - duracion);

    $('histDesde').value = valorParaInput(inicio);
    $('histHasta').value = valorParaInput(fin);
    tablaHistorial.desde = inicio;
    tablaHistorial.hasta = fin;

    await cargarTablaHistorial(0, true, true);
  }

  function aplicarRangoHoras(horas) {
    const fin = new Date();
    const inicio = new Date(fin.getTime() - horas * 3600000);

    $('histDesde').value = valorParaInput(inicio);
    $('histHasta').value = valorParaInput(fin);
    marcarRangoActivo(document.querySelector('.btn-rango[data-horas="' + horas + '"]'));
    cargarTablaHistorial(0);
  }

  function conectarFiltroHistorial() {
    const ahora = new Date();
    const horas = Number(HIST.horasPorDefecto) || 24;

    $('histDesde').value = valorParaInput(new Date(ahora.getTime() - horas * 3600000));
    $('histHasta').value = valorParaInput(ahora);

    $('filtroHistorial').addEventListener('submit', (evento) => {
      evento.preventDefault();
      marcarRangoActivo(null);
      cargarTablaHistorial(0);
    });

    document.querySelectorAll('.btn-rango').forEach((boton) => {
      boton.addEventListener('click', () => {
        aplicarRangoHoras(Number(boton.dataset.horas) || 24);
      });
    });

    $('historialCuerpo').addEventListener('click', (evento) => {
      const irARango = evento.target.closest('[data-ir-rango]');
      if (irARango) {
        aplicarRangoHoras(Number(irARango.dataset.irRango) || 24);
        return;
      }
      if (evento.target.closest('[data-reintentar]')) {
        cargarTablaHistorial(tablaHistorial.pagina, true);
      }
    });

    $('btnPaginaAnterior').addEventListener('click', () => {
      if (tablaHistorial.pagina > 0) {
        cargarTablaHistorial(tablaHistorial.pagina - 1, true);
      }
    });

    $('btnPaginaSiguiente').addEventListener('click', () => {
      if (tablaHistorial.total == null) return;
      const paginas = Math.ceil(tablaHistorial.total / tablaHistorial.porPagina);
      if (tablaHistorial.pagina + 1 < paginas) {
        cargarTablaHistorial(tablaHistorial.pagina + 1, true);
      }
    });

    marcarRangoActivo(document.querySelector('.btn-rango[data-horas="' + horas + '"]'));
  }

  /* --------------------------- MINI-TENDENCIAS ---------------------------- */

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
    marcarTarjetasObsoletas();
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
        TARJETAS.forEach((canal) => {
          const ref = tarjetas[canal.id];
          if (ref) dibujarSparkline(ref.lienzo, canal);
        });
      });
    };
    window.addEventListener('resize', redibujar);
    if (window.ResizeObserver) {
      const observador = new ResizeObserver(redibujar);
      document.querySelectorAll('canvas.sparkline').forEach((c) => observador.observe(c.parentElement));
    }
  }

  async function iniciar() {
    aplicarIdentidad();
    crearTarjetas();
    crearCabeceraHistorial();
    conectarFiltroHistorial();
    conectarBotonPantalla();
    observarTamano();
    pintarReloj();
    tick();

    await Promise.all([cargarHistorial(), cargarUltima()]);
    cargarTablaHistorial(0);

    setInterval(cargarUltima, CFG.actualizacion.ultimaMs);
    setInterval(cargarHistorial, CFG.actualizacion.historialMs);
    setInterval(tick, 1000);
    setInterval(() => {
      if (puedeAutoRefrescar()) refrescarHistorialEnVivo();
    }, Math.max(10000, Number(HIST.autoMs) || 30000));

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        cargarUltima();
        cargarHistorial();
        if (rangoEnVivo() && tablaHistorial.pagina === 0) {
          refrescarHistorialEnVivo();
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
