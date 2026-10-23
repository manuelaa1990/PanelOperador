/* ============================================================================
   PANEL DE SUPERVISIÓN PARA EL CLIENTE
   ----------------------------------------------------------------------------
   Este archivo es el único que hay que tocar para adaptar el panel a otro
   cliente, otra planta o cambiar los límites de alarma.

   Los datos se leen de la tabla `lecturas_hvac` de Supabase, la misma que
   escribe el ESP32 cada 10 segundos:

     created_at     timestamptz  fecha y hora de la lectura (UTC)
     presion_baja   float4       presión de succión  (PSI)
     presion_alta   float4       presión de descarga (PSI)
     temp1          float4       temperatura de succión        (°C)
     temp2          float4       salida del evaporador         (°C)
     temp3          float4       temperatura de descarga       (°C)
     temp4          float4       temperatura del líquido       (°C)
     temp5          float4       temperatura ambiente          (°C)
     wifi / ip / rssi            datos de conexión del equipo

   La clave que se usa es la "anon public" de Supabase. Es pública por diseño;
   la protección real está en las políticas RLS de la tabla. NUNCA poner aquí
   la clave `service_role`.
   ============================================================================ */

window.CONFIG_SUPERVISION = {

  /* ------------------------------ IDENTIDAD ------------------------------ */
  cliente: 'Cliente',
  planta: 'Sala de máquinas · Equipo 1',
  subtitulo: 'Supervisión en vivo',
  zonaHoraria: 'America/Caracas',

  /* ------------------------------- SUPABASE ------------------------------ */
  supabase: {
    url: 'https://qiidodrtxchurazrghyr.supabase.co',
    clave: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpaWRvZHJ0eGNodXJhenJnaHlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NDkwMDQsImV4cCI6MjEwODAyNTAwNH0.12wbnPavwGr4tEH1kz9ZtgSxHUYvL9gyrbMqFOBX2hg',
    tabla: 'lecturas_hvac'
  },

  /* --------------------------- RITMO DE ACTUALIZACIÓN --------------------- */
  actualizacion: {
    ultimaMs: 10000,      // consultar la última lectura cada 10 s
    historialMs: 60000,   // refrescar tarjetas y mini-tendencias cada 60 s
    ventanaHoras: 2       // ventana de las mini-tendencias de las tarjetas
  },

  /* ------------------------------- HISTORIAL ------------------------------ */
  historial: {
    porPagina: 100,       // filas por página de la tabla
    horasPorDefecto: 24,  // rango inicial: últimas 24 horas
    autoMs: 30000         // refresco automático cuando está "En vivo"
  },

  /* ------------------------------- FRESCURA ------------------------------- */
  /* El equipo envía cada 10 s. Si pasa más de 45 s sin datos, se avisa; a los
     3 minutos se considera que el equipo está sin señal. */
  frescura: {
    avisoMs: 45000,
    criticoMs: 180000
  },

  /* -------------------------------- EQUIPO -------------------------------- */
  equipo: {
    // Si la diferencia entre descarga y succión es menor, se muestra "En reposo".
    // Es un cálculo interno: no se enseña el número en pantalla.
    marchaDiferencialPsi: 30,

    // Reposo prolongado con las presiones igualadas
    reposoAvisoMin: 30,   // ámbar: puede ser una falla
    reposoFallaMin: 45,   // rojo: se considera falla

    // Ciclos cortos de la presión de succión (posible fuga, solenoide o presostato)
    ciclos: {
      ventanaMin: 60,          // se miran los ciclos de la última hora
      cortoMinMin: 0.5,        // un ciclo completo dura al menos 30 s
      cortoMaxMin: 5,          // y como máximo 5 min (con retardador)
      presionBajaMinPsi: 30,   // zona baja: cerca del mínimo del presostato
      presionBajaMaxPsi: 55,   // zona alta: recuperación de la presión
      minimo: 3                // 3 ciclos en la ventana = aviso
    }
  },

  /* ------------------------------- SEÑAL WIFI ----------------------------- */
  senal: {
    buena: -60,      // dBm mayores o iguales: buena
    regular: -72,    // dBm mayores o iguales: regular
    debil: -85       // dBm mayores o iguales: débil; por debajo: muy débil
  },

  /* ------------------------------- CONTACTO ------------------------------- */
  contacto: {
    nombre: 'técnico de guardia',
    telefono: ''            // ej. '+58 412 000 0000' (vacío = no se muestra)
  },

  /* --------------------------------------------------------------------------
     CANALES
     --------------------------------------------------------------------------
     nombre      texto que ve el vigilante (sin siglas técnicas)
     corto       etiqueta corta de la tarjeta y de la tabla
     unidad      °C o PSI
     decimales   cifras decimales que se muestran
     principal   true  -> tarjeta grande de la primera fila
     tarjeta     true  -> tarjeta adicional de la segunda fila
     compacta    true  -> versión compacta de la tarjeta adicional
                 (sin principal ni tarjeta: solo aparece en el historial)
     max         límite de alarma (rojo)
     aviso       valor de precaución (ámbar)
     min         límite inferior de alarma (opcional)
     avisoMin    precaución inferior (opcional)
     color       color de la tarjeta y de la mini-tendencia
     accion      recomendación que aparece en la alarma
     -------------------------------------------------------------------------- */
  canales: [
    {
      id: 'temp3', nombre: 'Temperatura de descarga', corto: 'T. descarga',
      unidad: '°C', decimales: 1, principal: true, color: '#ff9b4a',
      aviso: 90, max: 100,
      accion: 'Avisar al técnico de guardia. No manipule el equipo.'
    },
    {
      id: 'temp1', nombre: 'Temperatura de succión', corto: 'T. succión',
      unidad: '°C', decimales: 1, principal: true, color: '#54c7ff',
      aviso: 22, max: 25,
      accion: 'Avisar al técnico de guardia. No manipule el equipo.'
    },
    {
      id: 'presion_alta', nombre: 'Presión de descarga', corto: 'P. descarga',
      unidad: 'PSI', decimales: 1, principal: true, color: '#ff6b9d',
      aviso: 320, max: 350,
      accion: 'Avisar al técnico de guardia de inmediato.'
    },
    {
      id: 'presion_baja', nombre: 'Presión de succión', corto: 'P. succión',
      unidad: 'PSI', decimales: 1, principal: true, color: '#a78bfa',
      aviso: 110, max: 120,
      accion: 'Avisar al técnico de guardia. No manipule el equipo.'
    },
    {
      id: 'temp2', nombre: 'Salida del evaporador', corto: 'T. evaporador',
      unidad: '°C', decimales: 1, principal: false, tarjeta: true, compacta: true,
      color: '#3ddc97'
    },
    {
      id: 'temp4', nombre: 'Temperatura del líquido', corto: 'T. líquido',
      unidad: '°C', decimales: 1, principal: false, tarjeta: true, compacta: true,
      color: '#5eead4'
    },
    {
      id: 'temp5', nombre: 'Temperatura ambiente', corto: 'T. ambiente',
      unidad: '°C', decimales: 1, principal: false, tarjeta: true, compacta: true,
      color: '#facc15'
    }
  ]
};
